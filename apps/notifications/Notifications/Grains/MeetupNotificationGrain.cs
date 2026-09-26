using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Orleans.Runtime;

namespace Notifications.Grains;

/// <inheritdoc cref="IMeetupNotificationGrain" />
public sealed class MeetupNotificationGrain(
    GrainActivationStore activations,
    ReminderTaskStore tasks,
    ReplicaStore replica,
    CommunityTime community,
    FactTelemetry facts,
    IOptions<MeetupReminderOptions> options,
    TimeProvider clock,
    ILocalSiloDetails silo,
    ILogger<MeetupNotificationGrain> logger) : Grain, IMeetupNotificationGrain, IRemindable
{
    /// <summary>
    /// Имя reminder'а. Одно на грин: заданий на сходку тоже одно, и второе имя
    /// означало бы вторую модель владения.
    /// </summary>
    private const string ReminderName = "meetup-reminder";

    /// <summary>
    /// Период повтора reminder'а. Одноразовых reminder'ов Orleans не знает, а
    /// минимальный период ограничен снизу, поэтому напоминание снимается явно
    /// после успешного срабатывания. До тех пор повтор работает retry: грин,
    /// упавший на исполнении, будет разбужен снова, не дожидаясь sweeper'а.
    /// </summary>
    private static readonly TimeSpan ReminderRetryPeriod = TimeSpan.FromHours(1);

    private ActivationRecord? record;

    private MeetupReminderOptions Options => options.Value;

    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var key = this.GetPrimaryKeyString();

        // Запись идёт при активации, а не по запросу: доказывать нужно именно
        // подъём грина, и он должен оставить след независимо от того, вызовет
        // ли кто-нибудь метод.
        record = await activations.Record(key, silo.SiloAddress.ToString(), cancellationToken);

        // Имена плейсхолдеров и есть имена полей структурной записи, поэтому они
        // в snake_case: standards/observability/logging.md требует его, и так же
        // именует свои поля граница Meetups.
        logger.LogInformation(
            "Grain activated {grain_key} {silo} {activations}",
            record.GrainKey,
            record.Silo,
            record.Activations);

        await base.OnActivateAsync(cancellationToken);
    }

    public Task<ActivationRecord> Describe() =>
        Task.FromResult(record ?? throw new InvalidOperationException("grain is not activated"));

    public async Task ApplyReplica()
    {
        // Реплика читается здесь, внутри хода грина, а не у вызывающего. Ход
        // у сходки один, поэтому вызов, пришедший позже, всегда видит не
        // более старую реплику, чем пришедший раньше: два экземпляра сервиса,
        // применившие v5 и v6 и дошедшие сюда в обратном порядке, оба
        // приводят задание к последнему слову, а не откатывают его.
        var state = await replica.Meetup(Guid.Parse(this.GetPrimaryKeyString()), CancellationToken.None);

        await ApplySchedule(state is null ? null : community.StartsAt(state));
    }

    public async Task ApplySchedule(DateTimeOffset? startsAt)
    {
        var meetupId = this.GetPrimaryKeyString();
        var token = CancellationToken.None;

        // Момент приводится к точности хранения один раз и здесь: дальше он и
        // сравнивается с прочитанным из базы, и ищется в ней, и пишется в неё,
        // и все три должны говорить об одном и том же моменте.
        var moment = startsAt is { } given ? ReminderPlan.ToStoredPrecision(given) : (DateTimeOffset?)null;

        var live = await tasks.Live(meetupId, token);

        // Вопрос «срабатывало ли уже по этому моменту» задаётся всегда, когда
        // момент есть, — в том числе при живом задании. Сузить его до «живого
        // задания нет» нельзя: сходку можно увести на другую дату и вернуть
        // обратно, и тогда живое задание описывает чужой момент, а
        // запрошенный уже отработан. Без этого запроса такой возврат порождал
        // бы второе напоминание по одному и тому же моменту начала.
        var firedFor = moment is { } requested
            && await tasks.FiredFor(meetupId, requested, token);

        var decision = ReminderPlan.Decide(live?.StartsAt, firedFor, moment, Options.Lead);

        switch (decision.Action)
        {
            case ReminderAction.Create:
                await tasks.Create(meetupId, decision.StartsAt!.Value, decision.DueAt!.Value, Now(), token);
                await Wake(decision.DueAt!.Value);
                break;

            case ReminderAction.Supersede:
                await tasks.Supersede(
                    live!.TaskId,
                    meetupId,
                    decision.StartsAt!.Value,
                    decision.DueAt!.Value,
                    Now(),
                    "schedule moved",
                    token);
                await Wake(decision.DueAt!.Value);
                break;

            case ReminderAction.Cancel:
                // Две причины снятия, и они различаются в строке: расписание
                // потеряло время начала — или сходку вернули на момент, по
                // которому напоминание уже уходило. Разбирать молчащий
                // reminder (PER-223) по одной причине на оба случая нечем.
                await tasks.Cancel(
                    meetupId,
                    moment is null ? "schedule lost start time" : "reminder already fired for this start",
                    token);
                await Sleep();
                break;

            case ReminderAction.Keep:
            case ReminderAction.None:
            default:
                return;
        }

        logger.LogInformation(
            "Reminder task {action} {meetup_id} {due_at}",
            decision.Action,
            meetupId,
            decision.DueAt);

        // Момент мог быть уже позади — перенос ближе суток и возврат сходки
        // дают ровно это. Ждать reminder'а или прохода sweeper'а в таком случае
        // нельзя: ADR-028 требует исполнить наступившее немедленно.
        if (decision.DueAt is { } due && due <= Now())
        {
            await FireDue();
        }
    }

    public async Task<bool> FireDue()
    {
        var meetupId = this.GetPrimaryKeyString();
        var token = CancellationToken.None;

        var live = await tasks.Live(meetupId, token);

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

        var produced = await tasks.Fire(live, meetupId, Now(), token);
        var fired = produced is not null;

        if (produced is not null)
        {
            facts.Record(NotificationFacts.MeetupReminderType, produced);
            logger.LogInformation(
                "Reminder fired {meetup_id} {task_id} {facts_created} {facts_suppressed}",
                meetupId,
                live.TaskId,
                produced.Created,
                produced.Suppressed);
        }

        // Reminder снимается в обоих исходах. Задание перестало быть живым и
        // тогда, когда его исполнил кто-то другой между чтением и записью:
        // будить грин по нему больше незачем, а оставленный reminder тикал бы
        // ещё час до первого пробуждения, которое увидит пустоту.
        await Sleep();

        return fired;
    }

    /// <summary>Пробуждение по reminder'у ведёт в тот же путь, что и sweeper.</summary>
    public Task ReceiveReminder(string reminderName, TickStatus status) => FireDue();

    private DateTimeOffset Now() => clock.GetUtcNow();

    /// <summary>
    /// Просит рантайм разбудить грин к моменту срабатывания. Reminder — только
    /// механизм пробуждения: момент уже лежит строкой, и его потеря здесь
    /// стоит задержки до ближайшего прохода sweeper'а, а не напоминания.
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
