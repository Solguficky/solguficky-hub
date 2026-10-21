using System.Diagnostics;
using Microsoft.Extensions.Options;
using Notifications.Grains;
using Notifications.Infrastructure;
using Notifications.Observability;

namespace Notifications.Reminders;

/// <summary>
/// Проход по таблицам заданий напоминания — сходок, лота и начала окна — одним
/// процессом.
/// </summary>
/// <remarks>
/// Sweeper обязателен для корректности, а не желателен (ADR-029): Orleans
/// пишет в хранилище определение напоминания, но не конкретное срабатывание,
/// поэтому тик, пришедшийся на простой кластера, теряется и приходит только
/// следующий. Пропущенное таким образом задание подбирает только этот проход.
///
/// Все таблицы обходит один процесс и одним чтением: <see cref="ReminderDueStore" />
/// отдаёт наступившие сразу из всех. Второй процесс у лота означал бы второго
/// периодического потребителя соединений в каждом силосе, а это цена, которую
/// подтвердил интеграционный набор: при общем контейнере PostgreSQL число
/// соединений доходило до предела.
///
/// Сам он ничего не исполняет: находит наступившие задания и зовёт грин.
/// Исполнять здесь означало бы завести второго владельца задания рядом с
/// гринами, и единственность, которую даёт рантайм, перестала бы что-либо
/// значить.
/// </remarks>
public sealed class ReminderSweeper(
    ReminderDueStore due,
    IGrainFactory grains,
    IOptions<MeetupReminderOptions> options,
    TimeProvider clock,
    IHostApplicationLifetime lifetime,
    ReminderTelemetry telemetry,
    LotReminderTelemetry lotTelemetry,
    StepWindowTelemetry windowTelemetry,
    ILogger<ReminderSweeper> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Ждём готовности приложения, а не просто старта этого сервиса. Силос
        // Orleans поднимается таким же hosted service, и вызов грина до его
        // готовности падает; ApplicationStarted наступает после старта всех
        // hosted services, то есть когда силос уже принимает вызовы.
        //
        // Пропустить ожидание и ловить отказ первого прохода было бы дешевле
        // кодом, но именно первый проход — тот самый, ради которого sweeper
        // существует: он подбирает всё, что наступило за время простоя.
        if (!await Started(stoppingToken))
        {
            return;
        }

        var period = options.Value.SweepPeriod;
        using var timer = new PeriodicTimer(period, clock);

        do
        {
            await Sweep(stoppingToken);
        }
        while (await Tick(timer, stoppingToken));
    }

    private async Task<bool> Started(CancellationToken stoppingToken)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        await using var onStarted = lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        await using var onStopping = stoppingToken.Register(() => started.TrySetCanceled(stoppingToken));

        try
        {
            await started.Task;
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
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
        var requestId = Guid.NewGuid().ToString("N");
        using var scope = logger.BeginScope(new Dictionary<string, object> { ["request_id"] = requestId });
        telemetry.Tick();
        lotTelemetry.Tick();
        windowTelemetry.Tick();
        IReadOnlyList<DueReminder> pending;

        try
        {
            pending = await due.Due(clock.GetUtcNow(), options.Value.SweepBatchSize, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Остановка хоста — не отказ прохода.
            return;
        }
        catch (Exception ex)
        {
            // Упавший проход не имеет права убить цикл: следующий разберёт ту же
            // выборку, а молча остановившийся sweeper — это ровно тот молчащий
            // reminder, наблюдаемость которого заводит PER-223.
            logger.LogError(ex, "Reminder sweep failed to read due tasks");
            LogSnapshot("failed", 0, 1, null, "dependency_unavailable", requestId, startedAt);
            LogLotSnapshot("failed", 0, 1, null, "dependency_unavailable", requestId, startedAt);
            LogWindowSnapshot("failed", 0, 1, null, "dependency_unavailable", requestId, startedAt);
            return;
        }

        var meetups = pending.Where(task => task.MeetupId is not null).ToArray();
        var lots = pending.Where(task => task.LotId is not null).ToArray();
        var windows = pending.Where(task => task.WindowAuctionId is not null).ToArray();

        int meetupFailed;
        int lotFailed;
        int windowFailed;
        string? meetupCategory;
        string? lotCategory;
        string? windowCategory;

        try
        {
            // Отказ ловится на каждом задании отдельно, а не на всём проходе.
            // Иначе одно ядовитое задание останавливает проход на себе, а
            // следующий проход берёт ту же выборку в том же порядке и встаёт
            // на нём же: все остальные наступившие напоминания не уходят
            // никогда, и в логе об этом одна строка про упавший проход.
            (meetupFailed, meetupCategory) = await FireMeetups(meetups, stoppingToken);
            (lotFailed, lotCategory) = await FireLots(lots, stoppingToken);
            (windowFailed, windowCategory) = await FireWindows(windows, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }

        double? meetupOldest = null;
        double? lotOldest = null;
        double? windowOldest = null;
        try
        {
            var now = clock.GetUtcNow();
            var oldest = await due.OldestDueAgeSeconds(now, stoppingToken);
            meetupOldest = oldest.MeetupSeconds;
            lotOldest = oldest.LotSeconds;
            windowOldest = oldest.WindowSeconds;
            telemetry.ObserveOldestDue(meetupOldest.Value);
            lotTelemetry.ObserveOldestDue(lotOldest.Value);
            windowTelemetry.ObserveOldestDue(windowOldest.Value);

            if (meetupFailed == 0)
            {
                telemetry.Complete(now);
            }

            if (lotFailed == 0)
            {
                lotTelemetry.Complete(now);
            }

            if (windowFailed == 0)
            {
                windowTelemetry.Complete(now);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            meetupFailed++;
            lotFailed++;
            windowFailed++;
            meetupCategory ??= "dependency_unavailable";
            lotCategory ??= "dependency_unavailable";
            windowCategory ??= "dependency_unavailable";
            logger.LogError(ex, "Reminder sweep failed to read oldest due task");
        }

        LogSnapshot(meetupFailed == 0 ? "success" : "partial", meetups.Length, meetupFailed, meetupOldest, meetupCategory, requestId, startedAt);
        LogLotSnapshot(lotFailed == 0 ? "success" : "partial", lots.Length, lotFailed, lotOldest, lotCategory, requestId, startedAt);
        LogWindowSnapshot(windowFailed == 0 ? "success" : "partial", windows.Length, windowFailed, windowOldest, windowCategory, requestId, startedAt);
    }

    private async Task<(int Failed, string? Category)> FireMeetups(
        IReadOnlyList<DueReminder> tasks,
        CancellationToken stoppingToken)
    {
        var failed = 0;
        string? category = null;

        foreach (var task in tasks)
        {
            stoppingToken.ThrowIfCancellationRequested();
            var meetupId = task.MeetupId!;

            try
            {
                await grains.GetGrain<IMeetupNotificationGrain>(meetupId).FireDue();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                failed++;
                category = "unexpected";
                logger.LogError(ex, "Reminder task {task_id} {meetup_id} failed to fire", task.TaskId, meetupId);
            }
        }

        return (failed, category);
    }

    private async Task<(int Failed, string? Category)> FireLots(
        IReadOnlyList<DueReminder> tasks,
        CancellationToken stoppingToken)
    {
        var failed = 0;
        string? category = null;

        foreach (var task in tasks)
        {
            stoppingToken.ThrowIfCancellationRequested();
            var lotId = task.LotId!.Value;

            try
            {
                await grains.GetGrain<ILotNotificationGrain>(lotId.ToString()).FireDue();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                failed++;
                category = "unexpected";
                logger.LogError(ex, "Lot reminder task {task_id} {lot_id} failed to fire", task.TaskId, lotId);
            }
        }

        return (failed, category);
    }

    private async Task<(int Failed, string? Category)> FireWindows(
        IReadOnlyList<DueReminder> tasks,
        CancellationToken stoppingToken)
    {
        var failed = 0;
        string? category = null;

        foreach (var task in tasks)
        {
            stoppingToken.ThrowIfCancellationRequested();
            var auctionId = task.WindowAuctionId!.Value;

            try
            {
                // Задание начала окна живёт на аукцион: у одного аукциона
                // наступить могут несколько окон, и грин исполняет все свои
                // наступившие. Повторный вызов по второй строке того же
                // аукциона ничего не делает — строки уже не живые.
                await grains.GetGrain<IStepWindowNotificationGrain>(auctionId).FireDue();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                failed++;
                category = "unexpected";
                logger.LogError(ex, "Step window task {task_id} {auction_id} failed to fire", task.TaskId, auctionId);
            }
        }

        return (failed, category);
    }

    private void LogSnapshot(
        string status,
        int dueCount,
        int failedCount,
        double? oldestDueAgeSeconds,
        string? errorCategory,
        string requestId,
        long startedAt)
    {
        // Поля идут атрибутами и JSON в теле (Observability/OperationLog):
        // панели reminders читают тело через | json.
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "reminder_sweep",
            ["result"] = status == "success" ? "ok" : "error",
            ["request_id"] = requestId,
            ["sweep_status"] = status,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["sweep_at_unix_seconds"] = clock.GetUtcNow().ToUnixTimeSeconds(),
            ["last_successful_sweep_unix_seconds"] = telemetry.LastSuccessfulSweepUnixSeconds,
            ["due_count"] = dueCount,
            ["failed_count"] = failedCount,
            ["fired_total"] = telemetry.FiredTotal,
            ["removed_total"] = telemetry.RemovedTotal,
        };

        if (oldestDueAgeSeconds is not null)
        {
            fields["oldest_due_age_seconds"] = oldestDueAgeSeconds.Value;
        }

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = "Reminder sweep incomplete";
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);
    }

    private void LogLotSnapshot(
        string status,
        int dueCount,
        int failedCount,
        double? oldestDueAgeSeconds,
        string? errorCategory,
        string requestId,
        long startedAt)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "lot_reminder_sweep",
            ["result"] = status == "success" ? "ok" : "error",
            ["request_id"] = requestId,
            ["sweep_status"] = status,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["sweep_at_unix_seconds"] = clock.GetUtcNow().ToUnixTimeSeconds(),
            ["last_successful_sweep_unix_seconds"] = lotTelemetry.LastSuccessfulSweepUnixSeconds,
            ["due_count"] = dueCount,
            ["failed_count"] = failedCount,
            ["fired_total"] = lotTelemetry.FiredTotal,
            ["removed_total"] = lotTelemetry.RemovedTotal,
        };

        if (oldestDueAgeSeconds is not null)
        {
            fields["oldest_due_age_seconds"] = oldestDueAgeSeconds.Value;
        }

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = "Lot reminder sweep incomplete";
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);
    }

    private void LogWindowSnapshot(
        string status,
        int dueCount,
        int failedCount,
        double? oldestDueAgeSeconds,
        string? errorCategory,
        string requestId,
        long startedAt)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "step_window_sweep",
            ["result"] = status == "success" ? "ok" : "error",
            ["request_id"] = requestId,
            ["sweep_status"] = status,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["sweep_at_unix_seconds"] = clock.GetUtcNow().ToUnixTimeSeconds(),
            ["last_successful_sweep_unix_seconds"] = windowTelemetry.LastSuccessfulSweepUnixSeconds,
            ["due_count"] = dueCount,
            ["failed_count"] = failedCount,
            ["fired_total"] = windowTelemetry.FiredTotal,
            ["scheduled_total"] = windowTelemetry.ScheduledTotal,
        };

        if (oldestDueAgeSeconds is not null)
        {
            fields["oldest_due_age_seconds"] = oldestDueAgeSeconds.Value;
        }

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = "Step window sweep incomplete";
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);
    }
}
