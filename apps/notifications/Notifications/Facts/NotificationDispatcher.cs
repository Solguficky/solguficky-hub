using System.Diagnostics;
using Microsoft.Extensions.Options;
using NATS.Client.JetStream;
using Notifications.Infrastructure;
using Notifications.Messaging;
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

    /// <summary>
    /// Сколько отказов «всегда» (<see cref="BusRejection" />) строка переносит
    /// до вычёркивания. Такой отказ детерминирован, и повтор страхует только
    /// от единичного ошибочного ответа: попытки идут проход за проходом, без
    /// паузы, и перенастройку стрима не дожидаются. Уменьшенный по ошибке
    /// <c>max_msg_size</c> вычеркнет крупные строки за несколько секунд.
    /// </summary>
    public int MaxAttempts { get; set; } = 3;

    /// <summary>
    /// Горизонт хранения строки после её исхода — выноса, снятия или
    /// вычёркивания. Не меньше окна повтора повода плюс срок операторского
    /// разбора (docs/services/notifications.md).
    /// </summary>
    public TimeSpan Retention { get; set; } = TimeSpan.FromDays(30);

    /// <summary>Период чистки строк старше горизонта.</summary>
    public TimeSpan PrunePeriod { get; set; } = TimeSpan.FromHours(1);

    public const string ValidationMessage =
        "Notifications:Dispatch:MaxAttempts must be at least 1, PrunePeriod positive, " +
        "and Retention not shorter than Notifications:Replica:KeyRetention";

    /// <summary>
    /// Горизонт короче срока жизни ключей события сломал бы дедупликацию: ключ
    /// повода живёт в строке <c>notification</c>, и повтор события, ключ
    /// которого в <c>consumed_event</c> уже вычищен, после удаления строки
    /// родил бы второй факт. Ноль попыток вычеркнул бы строку без публикации.
    /// </summary>
    public static bool IsValid(DispatchOptions options, ConsumerOptions consumer) =>
        options.MaxAttempts >= 1
        && options.PrunePeriod > TimeSpan.Zero
        && options.Retention >= consumer.KeyRetention;
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
                Log(LogLevel.Error, startedAt, new PassSummary(0, 0, 0, 0), "dependency_unavailable", ex.Message, ex);
            }
        }
        while (await Tick(timer, stoppingToken));
    }

    private async Task Pass(long startedAt, CancellationToken stoppingToken)
    {
        var pass = await store.Dispatch(
            options.Value.BatchSize, options.Value.MaxAttempts, Publish, clock.GetUtcNow(), stoppingToken);
        telemetry.Dispatch(pass.Published);
        telemetry.RecordWithdrawn(NotificationFacts.WithdrawnExpired, pass.Expired);
        var expired = pass.Expired.Sum(facts => facts.Count);
        telemetry.RecordPass(expired, pass.Refused, pass.Rejected.Count);

        foreach (var rejected in pass.Rejected)
        {
            // Вычеркнутый факт потерян для человека, поэтому он — отказ по
            // нормативу: шина назвала причиной само сообщение, и это
            // нарушение её объявленного правила, а не её недоступность.
            ReplicaTelemetry.Fail("invariant");
            LogRejected(rejected);
        }

        var oldest = await store.OldestPending(stoppingToken);
        telemetry.ObserveOldestPending(oldest is { } moment ? (clock.GetUtcNow() - moment).TotalSeconds : 0);

        var summary = new PassSummary(pass.Published, expired, pass.Refused, pass.Rejected.Count);

        if (pass.Failure is { } failure)
        {
            telemetry.DispatchFailed();
            ReplicaTelemetry.Fail("dependency_unavailable");
            Log(LogLevel.Error, startedAt, summary, "dependency_unavailable", failure.Message, failure);
        }
        else if (summary.Any)
        {
            // Пустой проход не пишется: он повторяется раз в секунду, и лог
            // состоял бы из них. Молчащий релей виден по возрасту старейшего
            // неотправленного факта, а не по тишине в логе.
            Log(LogLevel.Information, startedAt, summary, null, null, null);
        }
    }

    private async Task Publish(PendingNotification notification, CancellationToken cancellationToken)
    {
        var ack = await jetStream.PublishAsync(
            Subject,
            notification.Payload,
            opts: new NatsJSPubOpts { MsgId = notification.NotificationId.ToString() },
            cancellationToken: cancellationToken);

        // Дубликат — это подтверждение, а не отказ: сообщение с этим
        // notification_id уже в стриме. Так выглядит повтор после публикации,
        // ответ на которую потерялся — шина замёрзла или оборвала соединение
        // уже после записи. EnsureSuccess бросил бы на нём исключение, и строка
        // стояла бы в очереди до конца окна дедупликации, хотя факт вынесен.
        if (ack.Duplicate)
        {
            return;
        }

        ack.EnsureSuccess();
    }

    private void Log(
        LogLevel level,
        long startedAt,
        PassSummary summary,
        string? errorCategory,
        string? error,
        Exception? exception)
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
            ["published"] = summary.Published,

            // Снятые по сроку годности: в шину не вынесены и не потеряны.
            ["expired"] = summary.Expired,

            // Отказ «всегда», после которого строка осталась в очереди, и
            // вычеркнутые: у каждой вычеркнутой ещё и своя запись.
            ["refused"] = summary.Refused,
            ["rejected"] = summary.Rejected,
        };

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = error ?? errorCategory;
        }

        OperationLog.Write(logger, level, exception, fields);
    }

    // Запись на строку, а не только сумма прохода: разбор начинается с
    // notification_id, по которому строку находят в таблице и у канала.
    private void LogRejected(RejectedNotification rejected) =>
        OperationLog.Write(logger, LogLevel.Error, rejected.Error, new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "notification_reject",
            ["result"] = "error",
            // Вычёркивание — отметка внутри прохода, а не своя операция:
            // длительность нулевая, как у перехода в BusConnectionWatcher.
            // Каркас требует поле всегда, а длину прохода несёт его запись.
            ["duration_us"] = 0L,
            ["error_category"] = "invariant",
            ["error"] = rejected.Error.Message,
            ["notification_id"] = rejected.NotificationId.ToString(),
            ["type"] = rejected.Type,
            ["attempts"] = rejected.Attempts,
        });

    private sealed record PassSummary(int Published, int Expired, int Refused, int Rejected)
    {
        public bool Any => Published > 0 || Expired > 0 || Refused > 0 || Rejected > 0;
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
