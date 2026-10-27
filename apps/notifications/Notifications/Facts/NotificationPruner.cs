using Microsoft.Extensions.Options;
using Notifications.Infrastructure;
using Notifications.Messaging;

namespace Notifications.Facts;

/// <summary>
/// Периодически удаляет адресные факты, исход которых старше горизонта
/// хранения. Без него таблица растёт на каждый факт и не уменьшается никогда.
/// </summary>
/// <remarks>
/// Горизонт у строки по её причине (<see cref="DispatchOptions.HorizonFor" />):
/// факт события аукциона живёт не меньше срока ключей <c>AUCTION_EVENTS</c>.
/// Шина ему не нужна: таблица существует и без неё, как и у чистки ключей
/// событий. Отказ прохода не останавливает цикл: следующий проход удалит то же
/// самое, а строка, прожившая лишний час, ничего не ломает.
/// </remarks>
public sealed class NotificationPruner(
    NotificationStore store,
    IOptions<DispatchOptions> options,
    IOptions<ConsumerOptions> consumer,
    TimeProvider clock,
    ILogger<NotificationPruner> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.PrunePeriod, clock);

        do
        {
            try
            {
                var (thresholds, fallback) = Thresholds(options.Value, consumer.Value, clock.GetUtcNow());
                var removed = await store.Prune(thresholds, fallback, stoppingToken);

                if (removed > 0)
                {
                    logger.LogInformation("Pruned {count} notifications past their horizon", removed);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Notification pruning failed");
            }
        }
        while (await Tick(timer, stoppingToken));
    }

    /// <summary>
    /// Порог по причине строки и запасной порог причины, которой в
    /// <see cref="DispatchOptions.CauseStreams" /> нет, на момент <paramref name="now" />.
    /// </summary>
    public static (IReadOnlyDictionary<string, DateTimeOffset> Thresholds, DateTimeOffset Fallback) Thresholds(
        DispatchOptions options, ConsumerOptions consumer, DateTimeOffset now) =>
        (DispatchOptions.CauseStreams.Keys.ToDictionary(cause => cause, cause => now - options.HorizonFor(cause, consumer)),
            now - options.UnknownCauseHorizon(consumer));

    private static async Task<bool> Tick(PeriodicTimer timer, CancellationToken stoppingToken)
    {
        try
        {
            return await timer.WaitForNextTickAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
