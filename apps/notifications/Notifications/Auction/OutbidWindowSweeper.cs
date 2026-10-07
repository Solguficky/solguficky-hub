using System.Diagnostics;
using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Observability;

namespace Notifications.Auction;

/// <summary>Настройки прохода по окнам частоты перебитий.</summary>
public sealed class OutbidWindowOptions
{
    public const string SectionName = "Notifications:OutbidWindows";

    /// <summary>
    /// Период прохода. Задаёт, насколько позже своего момента может уйти
    /// сообщение окна: при окнах в минуты полминуты незаметны.
    /// </summary>
    public TimeSpan SweepPeriod { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>Сколько окон закрывать за проход; остальные достанутся следующему.</summary>
    public int SweepBatchSize { get; set; } = 256;
}

/// <summary>
/// Закрывает наступившие окна частоты перебитий (PER-514): при старте и
/// периодически.
/// </summary>
/// <remarks>
/// Грина здесь нет, и это не расхождение с напоминаниями: у окна нет хода,
/// которому нужен единственный владелец в рантайме. Единственность сообщения
/// держит база — закрытие удаляет строку, и второй проход, дошедший до неё,
/// удаляет ноль строк, — а пропущенное за простой окно подбирает первый проход
/// после подъёма, потому что момент живёт строкой.
/// </remarks>
public sealed class OutbidWindowSweeper(
    AuctionStore store,
    IOptions<OutbidWindowOptions> options,
    FactTelemetry facts,
    TimeProvider clock,
    ILogger<OutbidWindowSweeper> logger) : BackgroundService
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
        IReadOnlyList<Infrastructure.OutbidWindowKey> due;
        try
        {
            due = await store.DueWindows(now, options.Value.SweepBatchSize, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            // Упавший проход не убивает цикл: следующий возьмёт ту же выборку.
            logger.LogError(ex, "Outbid window sweep failed to read due windows");
            Log(0, 1, 0, "dependency_unavailable", requestId, startedAt);
            return;
        }

        var failed = 0;
        var sent = 0;
        string? errorCategory = null;
        foreach (var key in due)
        {
            if (stoppingToken.IsCancellationRequested)
            {
                return;
            }

            // Отказ ловится на каждом окне, а не на проходе: иначе одно
            // ядовитое окно держало бы все остальные наступившие.
            try
            {
                sent += await store.CloseWindow(key, now, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                failed++;
                errorCategory = "unexpected";
                logger.LogError(ex, "Outbid window {lot_id} {identity_id} failed to close", key.LotId, key.RecipientId);
            }
        }

        if (sent > 0)
        {
            facts.Record(AuctionFacts.OutbidType, new FactCount(sent, 0));
        }
        // Пустой проход строки не пишет: раз в период он только шумел бы.
        if (due.Count > 0 || failed > 0)
        {
            Log(due.Count, failed, sent, errorCategory, requestId, startedAt);
        }
    }

    private void Log(int dueCount, int failedCount, int sent, string? errorCategory, string requestId, long startedAt)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "outbid_window_sweep",
            ["result"] = failedCount == 0 ? "ok" : "error",
            ["request_id"] = requestId,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["due_count"] = dueCount,
            ["failed_count"] = failedCount,
            ["facts_created"] = sent,
        };
        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = "Outbid window sweep incomplete";
        }
        OperationLog.Write(logger, failedCount == 0 ? LogLevel.Information : LogLevel.Error, null, fields);
    }
}
