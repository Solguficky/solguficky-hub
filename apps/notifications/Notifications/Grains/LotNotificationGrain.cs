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
    /// <summary>Имя reminder'а. Одно на грин: заданий у лота два, а грин один.</summary>
    private const string ReminderName = "lot-reminder";

    /// <summary>
    /// Период повтора reminder'а. Одноразовых reminder'ов Orleans не знает, а
    /// минимальный период ограничен снизу, поэтому напоминание снимается явно
    /// после успешного срабатывания; до тех пор повтор работает retry.
    /// </summary>
    private static readonly TimeSpan ReminderRetryPeriod = TimeSpan.FromHours(1);

    /// <summary>
    /// Моменты напоминания о дедлайне лота: за час и ближе к дедлайну
    /// (ADR-063, дополнение 2026-10-20).
    /// </summary>
    private static readonly LotReminderKind[] Kinds = [LotReminderKind.Hour, LotReminderKind.Close];

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

        // Решение по каждому моменту своё: часовое срабатывание не рождает
        // нового часового, а второй момент живёт своей жизнью и после него.
        foreach (var kind in Kinds)
        {
            await Apply(lotId, kind, moment, token);
        }

        await Settle(lotId, token);
    }

    private async Task Apply(Guid lotId, LotReminderKind kind, DateTimeOffset? moment, CancellationToken token)
    {
        var live = await tasks.Live(lotId, kind, token);
        // «Срабатывало ли» спрашивается только там, где ответ может изменить
        // решение: при совпавшем дедлайне задание остаётся, а без дедлайна
        // снимается — в обоих случаях ответ не читается.
        var fired = moment is not null
            && live?.Deadline != moment
            && await tasks.FiredEver(lotId, kind, token);
        var decision = LotReminderPlan.Decide(live?.Deadline, fired, moment, Lead(kind));

        switch (decision.Action)
        {
            case LotReminderAction.Create:
                await tasks.Create(lotId, kind, decision.Deadline!.Value, decision.DueAt!.Value, Now(), token);
                break;

            case LotReminderAction.Supersede:
                await tasks.Supersede(live!.TaskId, lotId, kind, decision.Deadline!.Value, decision.DueAt!.Value, Now(),
                    "deadline moved", token);
                break;

            case LotReminderAction.Cancel:
                // Две причины снятия, и они различаются в строке: дедлайна у
                // лота больше нет — или напоминание по нему уже уходило.
                await tasks.Cancel(lotId, kind, moment is null ? "lot has no deadline" : "reminder already fired", token);
                break;

            case LotReminderAction.Keep:
            case LotReminderAction.None:
            default:
                return;
        }

        logger.LogInformation("Lot reminder task {action} {kind} {lot_id} {due_at}", decision.Action, kind, lotId,
            decision.DueAt);
    }

    public async Task<bool> FireDue()
    {
        if (Key() is not { } lotId)
        {
            await Sleep();
            return false;
        }

        var token = CancellationToken.None;

        var live = await DueTask(lotId, token);

        if (live is null)
        {
            // Наступившего задания нет: живое задание может ждать свой момент —
            // его будить рано, а будить больше некого. Reminder мог пережить
            // снятие задания, если силос умер между двумя записями.
            await Settle(lotId, token);
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
            foreach (var kind in Kinds)
            {
                await tasks.Cancel(lotId, kind, "deadline passed", token);
            }
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
            facts.Record(FactType(live.Kind), result.Facts);
            logger.LogInformation(
                "Lot reminder fired {kind} {lot_id} {task_id} {facts_created} {facts_suppressed}",
                live.Kind,
                lotId,
                live.TaskId,
                result.Facts.Created,
                result.Facts.Suppressed);
        }

        // Reminder живёт, пока жив хоть один момент: после срабатывания часового
        // второй ещё ждёт своего.
        await Settle(lotId, token);

        return result.Outcome == LotFireOutcome.Sent;
    }

    /// <summary>Пробуждение по reminder'у ведёт в тот же путь, что и sweeper.</summary>
    public Task ReceiveReminder(string reminderName, TickStatus status) => FireDue();

    private DateTimeOffset Now() => clock.GetUtcNow();

    /// <summary>Ключ грина как идентификатор лота; <c>null</c> — ключ лотом не является.</summary>
    private Guid? Key() =>
        Guid.TryParse(this.GetPrimaryKeyString(), out var lotId) ? lotId : null;

    /// <summary>
    /// Приводит reminder'а к ближайшему живому моменту и исполняет наступивший:
    /// ждать reminder'а нельзя, наступившее исполняют немедленно.
    /// </summary>
    private async Task Settle(Guid lotId, CancellationToken token)
    {
        var due = await NextDue(lotId, token);
        if (due is not { } moment)
        {
            await Sleep();
            return;
        }

        if (moment <= Now())
        {
            await FireDue();
            return;
        }

        await Wake(moment);
    }

    /// <summary>Живые задания лота: по видам, без повторов.</summary>
    private async Task<IReadOnlyList<LiveLotReminderTask>> LiveTasks(Guid lotId, CancellationToken token)
    {
        var live = new List<LiveLotReminderTask>(Kinds.Length);
        foreach (var kind in Kinds)
        {
            var task = await tasks.Live(lotId, kind, token);
            if (task is not null)
            {
                live.Add(task);
            }
        }
        return live;
    }

    /// <summary>Ближайший момент живых заданий лота.</summary>
    private async Task<DateTimeOffset?> NextDue(Guid lotId, CancellationToken token)
    {
        var live = await LiveTasks(lotId, token);
        return live.Count == 0 ? null : live.Min(task => task.DueAt);
    }

    /// <summary>Живое задание, чей момент наступил: их два, и срабатывает то, что ждало дольше.</summary>
    private async Task<LiveLotReminderTask?> DueTask(Guid lotId, CancellationToken token)
    {
        var live = await LiveTasks(lotId, token);
        var due = live.Where(task => task.DueAt <= Now()).ToArray();
        return due.Length == 0 ? null : due.MinBy(task => task.DueAt);
    }

    private TimeSpan Lead(LotReminderKind kind) => kind switch
    {
        LotReminderKind.Hour => Options.Lead,
        LotReminderKind.Close => Options.CloseLead,
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    private static string FactType(LotReminderKind kind) => NotificationFacts.TypeOf(kind);

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
