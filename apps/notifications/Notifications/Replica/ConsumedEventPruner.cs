using Microsoft.Extensions.Options;
using Notifications.Infrastructure;

namespace Notifications.Replica;

/// <summary>
/// Периодически снимает ключи дедупликации старше окна хранения. Без него
/// таблица растёт на каждое событие шины и не уменьшается никогда.
/// </summary>
/// <remarks>
/// Отказ прохода не останавливает цикл: следующий проход снимет то же самое, а
/// ключ, проживший лишний час, ничего не ломает.
/// </remarks>
public sealed class ConsumedEventPruner(
    ReplicaStore store,
    IOptions<ReplicaOptions> options,
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
                var threshold = clock.GetUtcNow() - options.Value.KeyRetention;
                var removed = await store.Prune(threshold, stoppingToken);

                if (removed > 0)
                {
                    logger.LogInformation("Pruned {count} consumed event keys older than {threshold}", removed, threshold);
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
