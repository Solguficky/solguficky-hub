using System.Diagnostics;
using Microsoft.Extensions.Options;
using Notifications.Grains;
using Notifications.Infrastructure;
using Notifications.Observability;

namespace Notifications.Reminders;

/// <summary>
/// Проход по таблице заданий: при старте силоса и периодически.
/// </summary>
/// <remarks>
/// Sweeper обязателен для корректности, а не желателен (ADR-029). Orleans
/// пишет в хранилище определение напоминания, но не конкретное срабатывание,
/// поэтому тик, пришедшийся на простой кластера, теряется и приходит только
/// следующий; для напоминания за сутки «следующий период» смысла не имеет.
/// Пропущенное таким образом задание подбирает только этот проход.
///
/// Сам он ничего не исполняет: находит наступившие задания и зовёт грин
/// сходки. Исполнять здесь означало бы завести второго владельца задания рядом
/// с гринами, и единственность, которую даёт рантайм, перестала бы что-либо
/// значить.
/// </remarks>
public sealed class ReminderSweeper(
    ReminderTaskStore tasks,
    IGrainFactory grains,
    IOptions<MeetupReminderOptions> options,
    TimeProvider clock,
    IHostApplicationLifetime lifetime,
    ReminderTelemetry telemetry,
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
        IReadOnlyList<DueReminderTask> due;

        try
        {
            due = await tasks.Due(clock.GetUtcNow(), options.Value.SweepBatchSize, stoppingToken);
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
            return;
        }

        var failed = 0;
        string? errorCategory = null;

        foreach (var task in due)
        {
            if (stoppingToken.IsCancellationRequested)
            {
                return;
            }

            // Отказ ловится на каждом задании отдельно, а не на всём проходе.
            // Иначе одно ядовитое задание останавливает проход на себе, а
            // следующий проход берёт ту же выборку в том же порядке и встаёт
            // на нём же: все остальные наступившие напоминания не уходят
            // никогда, и в логе об этом одна строка про упавший проход.
            try
            {
                await grains.GetGrain<IMeetupNotificationGrain>(task.MeetupId).FireDue();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                failed++;
                errorCategory = "unexpected";
                logger.LogError(ex, "Reminder task {task_id} {meetup_id} failed to fire", task.TaskId, task.MeetupId);
            }
        }

        double? oldestDueAge = null;
        try
        {
            var now = clock.GetUtcNow();
            oldestDueAge = await tasks.OldestDueAgeSeconds(now, stoppingToken);
            telemetry.ObserveOldestDue(oldestDueAge.Value);

            if (failed == 0)
            {
                telemetry.Complete(now);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            failed++;
            errorCategory ??= "dependency_unavailable";
            logger.LogError(ex, "Reminder sweep failed to read oldest due task");
        }

        LogSnapshot(failed == 0 ? "success" : "partial", due.Count, failed, oldestDueAge, errorCategory, requestId, startedAt);
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
}
