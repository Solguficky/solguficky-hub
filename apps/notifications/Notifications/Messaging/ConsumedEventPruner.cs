using Microsoft.Extensions.Options;

namespace Notifications.Messaging;

/// <summary>
/// Периодически снимает ключи дедупликации старше окна хранения. Без него
/// таблица растёт на каждое событие шины и не уменьшается никогда.
/// </summary>
/// <remarks>
/// Порог у каждого источника свой — срок ключей его стрима: ключ без
/// известного потока вычистить по чужому сроку значило бы угадать.
/// Отказ прохода не останавливает цикл: следующий проход снимет то же самое, а
/// ключ, проживший лишний час, ничего не ломает.
/// </remarks>
public sealed class ConsumedEventPruner(
    ConsumedEventStore store,
    IReadOnlyList<EventFeed> feeds,
    IOptions<ConsumerOptions> options,
    TimeProvider clock,
    ILogger<ConsumedEventPruner> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.PrunePeriod, clock);

        do
        {
            try
            {
                var removed = await store.Prune(Thresholds(feeds, options.Value, clock.GetUtcNow()), stoppingToken);

                if (removed > 0)
                {
                    logger.LogInformation("Pruned {count} consumed event keys past their stream retention", removed);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Consumed event pruning failed");
            }
        }
        while (await Tick(timer, stoppingToken));
    }

    /// <summary>Порог чистки каждого источника на момент <paramref name="now" />.</summary>
    public static IReadOnlyDictionary<string, DateTimeOffset> Thresholds(
        IEnumerable<EventFeed> feeds, ConsumerOptions options, DateTimeOffset now) =>
        feeds.ToDictionary(feed => feed.Source, feed => now - options.KeyRetentionFor(feed.Stream));

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
