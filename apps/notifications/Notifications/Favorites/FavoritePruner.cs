using Microsoft.Extensions.Options;
using Notifications.Facts;

namespace Notifications.Favorites;

/// <summary>
/// Периодически удаляет реплику лота и его отметки, когда лот пришёл в
/// конечное положение раньше горизонта хранения (ADR-063, п. 6).
/// </summary>
/// <remarks>
/// Горизонт и период — те же, что у адресных фактов
/// (<see cref="DispatchOptions" />): ADR-063 связывает срок отметок с
/// <c>Notifications:Dispatch:Retention</c>, а не заводит свой. Он длиннее
/// хранения стрима, поэтому удалённую реплику старый факт из шины не
/// воскресит. Отказ прохода не останавливает цикл: следующий удалит то же самое.
/// </remarks>
public sealed class FavoritePruner(
    FavoriteOperations favorites,
    IOptions<DispatchOptions> options,
    TimeProvider clock,
    ILogger<FavoritePruner> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.PrunePeriod, clock);

        do
        {
            try
            {
                var threshold = clock.GetUtcNow() - options.Value.Retention;
                var removed = await favorites.Prune(threshold, stoppingToken);

                if (removed > 0)
                {
                    logger.LogInformation("Pruned favorites of {count} lots closed before {threshold}", removed, threshold);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Favorite pruning failed");
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
