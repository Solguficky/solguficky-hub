using System.Diagnostics;
using Microsoft.Extensions.Options;
using NATS.Client.JetStream;
using Notifications.Infrastructure;
using Notifications.Observability;
using Notifications.Replica;

namespace Notifications.Facts;

/// <summary>Настройки релея адресных фактов.</summary>
public sealed class DispatchOptions
{
    public const string SectionName = "Notifications:Dispatch";

    /// <summary>
    /// Период прохода. Он же верхняя граница задержки между коммитом повода и
    /// публикацией: поток — десятки поводов в день, и опрос дешевле сигнала,
    /// который пришлось бы вести между двумя службами.
    /// </summary>
    public TimeSpan Period { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>Сколько строк берёт один проход.</summary>
    public int BatchSize { get; set; } = 100;
}

/// <summary>
/// Релей outbox: выносит неотправленные адресные факты из таблицы
/// <c>notification</c> в шину. На этом ответственность Notifications
/// заканчивается (ADR-028): что стало с сообщением дальше, сервис не знает.
/// </summary>
/// <remarks>
/// <c>Nats-Msg-Id</c> равен <c>notification_id</c>: повтор публикации, который
/// даёт падение между подтверждением шины и коммитом отметки, сервер отсекает
/// в окне дедупликации, а после окна — канал по тому же идентификатору.
///
/// Стрим сервис не заводит, как и durable: его объявляет топология AppHost
/// (ADR-050). Без стрима публикация получает отказ, проход пишет ошибку и
/// повторяет через период, а факты ждут в таблице.
/// </remarks>
public sealed class NotificationDispatcher(
    INatsJSContext jetStream,
    NotificationStore store,
    FactTelemetry telemetry,
    IOptions<DispatchOptions> options,
    TimeProvider clock,
    ILogger<NotificationDispatcher> logger) : BackgroundService
{
    /// <summary>Subject адресного факта (docs/architecture/integration.md, «Notifications NATS»).</summary>
    public const string Subject = "events.notifications.notification_created";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.Period, clock);

        do
        {
            var startedAt = Stopwatch.GetTimestamp();

            try
            {
                await Pass(startedAt, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Отказ базы: таблица на месте, следующий проход повторит.
                telemetry.DispatchFailed();
                ReplicaTelemetry.Fail("dependency_unavailable");
                Log(LogLevel.Error, startedAt, 0, "dependency_unavailable", ex.Message, ex, 0);
            }
        }
        while (await Tick(timer, stoppingToken));
    }

    private async Task Pass(long startedAt, CancellationToken stoppingToken)
    {
        var pass = await store.Dispatch(options.Value.BatchSize, Publish, clock.GetUtcNow(), stoppingToken);
        telemetry.Dispatch(pass.Published);
        telemetry.RecordWithdrawn(NotificationFacts.WithdrawnExpired, pass.Expired);
        var expired = pass.Expired.Sum(facts => facts.Count);

        var oldest = await store.OldestPending(stoppingToken);
        telemetry.ObserveOldestPending(oldest is { } moment ? (clock.GetUtcNow() - moment).TotalSeconds : 0);

        if (pass.Failure is { } failure)
        {
            telemetry.DispatchFailed();
            ReplicaTelemetry.Fail("dependency_unavailable");
            Log(LogLevel.Error, startedAt, pass.Published, "dependency_unavailable", failure.Message, failure, expired);
        }
        else if (pass.Published > 0 || expired > 0)
        {
            // Пустой проход не пишется: он повторяется раз в секунду, и лог
            // состоял бы из них. Молчащий релей виден по возрасту старейшего
            // неотправленного факта, а не по тишине в логе.
            Log(LogLevel.Information, startedAt, pass.Published, null, null, null, expired);
        }
    }

    private async Task Publish(PendingNotification notification, CancellationToken cancellationToken)
    {
        var ack = await jetStream.PublishAsync(
            Subject,
            notification.Payload,
            opts: new NatsJSPubOpts { MsgId = notification.NotificationId.ToString() },
            cancellationToken: cancellationToken);

        ack.EnsureSuccess();
    }

    private void Log(
        LogLevel level,
        long startedAt,
        int published,
        string? errorCategory,
        string? error,
        Exception? exception,
        int expired)
    {
        // Та же форма, что у replica_apply и снимка sweeper'а
        // (Observability/OperationLog), с каркасом
        // docs/standards/observability/logging.md.
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "notification_dispatch",
            ["result"] = errorCategory is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["published"] = published,

            // Снятые по сроку годности: в шину не вынесены и не потеряны.
            ["expired"] = expired,
        };

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = error ?? errorCategory;
        }

        OperationLog.Write(logger, level, exception, fields);
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
