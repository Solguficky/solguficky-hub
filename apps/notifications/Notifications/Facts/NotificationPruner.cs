using Microsoft.Extensions.Options;
using Notifications.Infrastructure;

namespace Notifications.Facts;

/// <summary>
/// Периодически удаляет адресные факты, исход которых старше горизонта
/// хранения. Без него таблица растёт на каждый факт и не уменьшается никогда.
/// </summary>
/// <remarks>
/// Шина ему не нужна: таблица существует и без неё, как и у чистки ключей
/// событий. Отказ прохода не останавливает цикл: следующий проход удалит то же
/// самое, а строка, прожившая лишний час, ничего не ломает.
/// </remarks>
public sealed class NotificationPruner(
    NotificationStore store,
    IOptions<DispatchOptions> options,
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
                var threshold = clock.GetUtcNow() - options.Value.Retention;
                var removed = await store.Prune(threshold, stoppingToken);

                if (removed > 0)
                {
                    logger.LogInformation("Pruned {count} notifications closed before {threshold}", removed, threshold);
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
