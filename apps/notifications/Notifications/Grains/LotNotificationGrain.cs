using Microsoft.Extensions.Options;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Npgsql;

namespace Notifications.Grains;

/// <inheritdoc cref="ILotNotificationGrain" />
public sealed class LotNotificationGrain(
    LotReminderTaskStore tasks,
    NpgsqlDataSource source,
    FactTelemetry facts,
    IOptions<LotReminderOptions> options,
    TimeProvider clock,
    ILogger<LotNotificationGrain> logger) : Grain, ILotNotificationGrain, IRemindable
{
    /// <summary>Имя reminder'а. Одно на грин: заданий на лот тоже одно.</summary>
    private const string ReminderName = "lot-reminder";

    /// <summary>
    /// Период повтора reminder'а. Одноразовых reminder'ов Orleans не знает, а
    /// минимальный период ограничен снизу, поэтому напоминание снимается явно
    /// после успешного срабатывания; до тех пор повтор работает retry.
    /// </summary>
    private static readonly TimeSpan ReminderRetryPeriod = TimeSpan.FromHours(1);

    private LotReminderOptions Options => options.Value;

    public async Task ApplyReplica()
    {
        // Реплика читается здесь, внутри хода грина: ход у лота один, поэтому
        // вызов, пришедший позже, всегда видит не более старый снимок. Лота,
        // которого реплика не знает, для напоминания нет.
        var deadline = Key() is { } lotId
            ? (await LotReplicaStore.Read(source, lotId, CancellationToken.None))?.Deadline
            : null;

        await ApplyDeadline(deadline);
    }

    public async Task ApplyDeadline(DateTimeOffset? deadline)
    {
        if (Key() is not { } lotId)
        {
            // Ключ не лот — задания у такого ключа быть не может.
            return;
        }

        var token = CancellationToken.None;

        // Момент приводится к точности хранения один раз и здесь: дальше он и
        // сравнивается с прочитанным из базы, и пишется в неё.
        var moment = deadline is { } given ? ReminderPlan.ToStoredPrecision(given) : (DateTimeOffset?)null;

        var live = await tasks.Live(lotId, token);
        // «Срабатывало ли» спрашивается только там, где ответ может изменить
        // решение: при совпавшем дедлайне задание остаётся, а без дедлайна
        // снимается — в обоих случаях ответ не читается.
        var fired = moment is not null
            && live?.Deadline != moment
            && await tasks.FiredEver(lotId, token);
        var decision = LotReminderPlan.Decide(live?.Deadline, fired, moment, Options.Lead);

        switch (decision.Action)
        {
            case LotReminderAction.Create:
                await tasks.Create(lotId, decision.Deadline!.Value, decision.DueAt!.Value, Now(), token);
                await Wake(decision.DueAt!.Value);
                break;

            case LotReminderAction.Supersede:
                await tasks.Supersede(live!.TaskId, lotId, decision.Deadline!.Value, decision.DueAt!.Value, Now(), "deadline moved", token);
                await Wake(decision.DueAt!.Value);
                break;

            case LotReminderAction.Cancel:
                // Две причины снятия, и они различаются в строке: дедлайна у
                // лота больше нет — или напоминание по нему уже уходило.
                await tasks.Cancel(lotId, moment is null ? "lot has no deadline" : "reminder already fired", token);
                await Sleep();
                break;

            case LotReminderAction.Keep:
            case LotReminderAction.None:
            default:
                return;
        }

        logger.LogInformation("Lot reminder task {action} {lot_id} {due_at}", decision.Action, lotId, decision.DueAt);

        // Момент мог быть уже позади — перенос ближе часа даёт ровно это.
        // Ждать reminder'а нельзя: наступившее исполняют немедленно.
        if (decision.DueAt is { } due && due <= Now())
        {
            await FireDue();
        }
    }

    public async Task<bool> FireDue()
    {
        if (Key() is not { } lotId)
        {
            await Sleep();
            return false;
        }

        var token = CancellationToken.None;

        var live = await tasks.Live(lotId, token);

        if (live is null)
        {
            // Живого задания нет — будить больше некого. Reminder мог пережить
            // снятие задания, если силос умер между двумя записями.
            await Sleep();
            return false;
        }

        if (live.DueAt > Now())
        {
            return false;
        }

        // Задание могло отстать от реплики: консьюмер коммитит реплику раньше,
        // чем зовёт грин. Сначала задание догоняет реплику; если момент
        // по-прежнему наступил, ApplyDeadline исполнит его сам.
        var replica = await LotReplicaStore.Read(source, lotId, token);
        if (replica?.Deadline is not { } deadline || deadline != live.Deadline)
        {
            await ApplyDeadline(replica?.Deadline);
            return false;
        }

        // Дедлайн уже прошёл — лот закрывается или закрылся, и «остался час»
        // было бы шумом. Конечное положение и удержание дают пустой дедлайн в
        // реплике, поэтому их ловит ветка выше.
        if (deadline <= Now())
        {
            await tasks.Cancel(lotId, "deadline passed", token);
            await Sleep();
            return false;
        }

        var result = await tasks.Fire(live, lotId, Now(), token);

        if (result.Outcome == LotFireOutcome.Stale)
        {
            // Задание отстало от реплики между чтением и захватом: оно осталось
            // живым, и его приводит к последнему слову реплики тот же путь, что
            // и любое изменение дедлайна.
            var current = await LotReplicaStore.Read(source, lotId, token);
            await ApplyDeadline(current?.Deadline);
            return false;
        }

        if (result.Outcome == LotFireOutcome.Sent)
        {
            facts.Record(NotificationFacts.LotReminderType, result.Facts);
            logger.LogInformation(
                "Lot reminder fired {lot_id} {task_id} {facts_created} {facts_suppressed}",
                lotId,
                live.TaskId,
                result.Facts.Created,
                result.Facts.Suppressed);
        }

        // Reminder снимается в обоих исходах: задание перестало быть живым.
        await Sleep();

        return result.Outcome == LotFireOutcome.Sent;
    }

    /// <summary>Пробуждение по reminder'у ведёт в тот же путь, что и sweeper.</summary>
    public Task ReceiveReminder(string reminderName, TickStatus status) => FireDue();

    private DateTimeOffset Now() => clock.GetUtcNow();

    /// <summary>Ключ грина как идентификатор лота; <c>null</c> — ключ лотом не является.</summary>
    private Guid? Key() =>
        Guid.TryParse(this.GetPrimaryKeyString(), out var lotId) ? lotId : null;

    /// <summary>
    /// Просит рантайм разбудить грин к моменту срабатывания. Reminder — только
    /// механизм пробуждения: момент уже лежит строкой.
    /// </summary>
    private async Task Wake(DateTimeOffset dueAt)
    {
        var delay = dueAt - Now();

        await this.RegisterOrUpdateReminder(
            ReminderName,
            delay > TimeSpan.Zero ? delay : TimeSpan.Zero,
            ReminderRetryPeriod);
    }

    private async Task Sleep()
    {
        if (await this.GetReminder(ReminderName) is { } reminder)
        {
            await this.UnregisterReminder(reminder);
        }
    }
}
