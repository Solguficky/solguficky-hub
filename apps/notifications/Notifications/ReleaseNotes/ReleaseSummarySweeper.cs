using System.Diagnostics;
using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Observability;

namespace Notifications.ReleaseNotes;

/// <summary>
/// Закрывает наступивший час сводки «Что нового» (ADR-069, п. 4): при старте и
/// периодически.
/// </summary>
/// <remarks>
/// Грина здесь нет по той же причине, что у окон сводки перебитий: единственность
/// сводки за час держит строка поверхности — закрытие переносит её момент на
/// завтра в своей транзакции, — а час, пропущенный за простой, подбирает первый
/// проход после подъёма, потому что момент живёт строкой.
/// </remarks>
public sealed class ReleaseSummarySweeper(
    ReleaseNotesStore store,
    IOptions<ReleaseNotesOptions> options,
    FactTelemetry facts,
    TimeProvider clock,
    ILogger<ReleaseSummarySweeper> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.SweepPeriod, clock);
        do
        {
            await Sweep(stoppingToken);
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

    private async Task Sweep(CancellationToken stoppingToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        // Проход порождает факты сам и потому — край своей цепочки: id на
        // проход, как у прохода напоминаний.
        var requestId = Guid.NewGuid().ToString("N");
        using var scope = logger.BeginScope(new Dictionary<string, object> { ["request_id"] = requestId });
        var now = clock.GetUtcNow();
        IReadOnlyList<ReleaseSurface> due;
        try
        {
            due = await store.Due(now, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            // Упавший проход не убивает цикл: следующий возьмёт ту же выборку.
            logger.LogError(ex, "Release summary sweep failed to read due surfaces");
            Log(0, 1, 0, 0, "dependency_unavailable", requestId, startedAt);
            return;
        }

        var failed = 0;
        var summaries = 0;
        var created = 0;
        string? errorCategory = null;
        foreach (var surface in due)
        {
            if (stoppingToken.IsCancellationRequested)
            {
                return;
            }

            // Отказ ловится на каждой поверхности: одна сломанная не держит другую.
            try
            {
                if (await store.Close(surface, now, stoppingToken) is { } closed)
                {
                    summaries++;
                    created += closed.Facts.Created;
                    facts.Record(ReleaseFacts.SummaryType, closed.Facts);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                failed++;
                errorCategory = "unexpected";
                logger.LogError(ex, "Release summary of {surface} failed to close", surface.Name);
            }
        }

        // Пустой проход строки не пишет: раз в минуту он только шумел бы.
        if (due.Count > 0 || failed > 0)
        {
            Log(due.Count, failed, summaries, created, errorCategory, requestId, startedAt);
        }
    }

    private void Log(int dueCount, int failedCount, int summaries, int created, string? errorCategory,
        string requestId, long startedAt)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "release_summary_sweep",
            ["result"] = failedCount == 0 ? "ok" : "error",
            ["request_id"] = requestId,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["due_count"] = dueCount,
            ["failed_count"] = failedCount,
            ["summaries_created"] = summaries,
            ["facts_created"] = created,
        };
        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = "Release summary sweep incomplete";
        }
        OperationLog.Write(logger, failedCount == 0 ? LogLevel.Information : LogLevel.Error, null, fields);
    }
}
