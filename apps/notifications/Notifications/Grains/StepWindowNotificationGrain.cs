using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Npgsql;

namespace Notifications.Grains;

/// <inheritdoc cref="IStepWindowNotificationGrain" />
/// <remarks>
/// Устроен как грин напоминания: момент лежит строкой в
/// <c>step_window_task</c>, Orleans только будит его к моменту срабатывания, а
/// пропущенный за время простоя тик подбирает sweeper. Ключ — аукцион, потому
/// что окна его лотов принадлежат одному заданию на момент начала, а не лоту:
/// сообщение называет лоты разных людей одной вестью.
/// </remarks>
public sealed class StepWindowNotificationGrain(
    StepWindowTaskStore tasks,
    NpgsqlDataSource source,
    FactTelemetry facts,
    IOptions<StepWindowOptions> options,
    TimeProvider clock,
    ILogger<StepWindowNotificationGrain> logger) : Grain, IStepWindowNotificationGrain, IRemindable
{
    /// <summary>Имя reminder'а. Одно на грин: заданий у аукциона столько, сколько у него начал окон.</summary>
    private const string ReminderName = "step-window";

    /// <summary>
    /// Период повтора reminder'а. Одноразовых reminder'ов Orleans не знает, а
    /// минимальный период ограничен снизу, поэтому reminder снимается явно
    /// после последнего срабатывания; до тех пор повтор работает retry.
    /// </summary>
    private static readonly TimeSpan ReminderRetryPeriod = TimeSpan.FromHours(1);

    private StepWindowOptions Options => options.Value;

    public async Task ApplyLot(Guid lotId)
    {
        var token = CancellationToken.None;
        var auctionId = this.GetPrimaryKey();

        // Реплика читается здесь, внутри хода грина: она уже закоммичена
        // потребителем вместе с ключом события, и её последнее слово — то, по
        // которому решается задание.
        var replica = await LotReplicaStore.Read(source, lotId, token);
        if (replica is not { AuctionId: { } owner } || owner != auctionId)
        {
            // Лот другого аукциона или реплика без аукциона (записанная до
            // PER-604): окна такого лота этому грину не принадлежат.
            return;
        }

        var now = Now();
        foreach (var window in replica.Windows)
        {
            if (!StepWindowPlan.Running(window, now))
            {
                // Окно уже кончилось: объявлять о нём нечего, и задание на
                // прошедшее начало не заводится.
                continue;
            }

            await tasks.Create(auctionId, window.From, StepWindowPlan.DueAt(window.From, now, Options.Hold), now, token);
        }

        await Settle(auctionId, token);
    }

    public async Task<bool> FireDue()
    {
        var token = CancellationToken.None;
        var auctionId = this.GetPrimaryKey();
        var now = Now();
        var due = await tasks.Due(auctionId, now, token);

        var sent = false;
        foreach (var task in due)
        {
            var result = await tasks.Fire(task, now, token);

            if (result.Outcome != StepWindowFireOutcome.Sent)
            {
                continue;
            }

            // «Исполнено» и «сообщение ушло» — разные вещи: пустая аудитория,
            // кончившийся аукцион и кончившееся окно дают ноль фактов обоих
            // видов. Ноль и назван ниже как ноль, чтобы систематический промах
            // сверки не выглядел успехом.
            facts.Record(NotificationFacts.StepWindowStartedType, result.Facts.Started);
            facts.Record(NotificationFacts.StepWindowAnnouncedType, result.Facts.Announced);

            if (result.Facts.Started.Created == 0 && result.Facts.Announced.Created == 0)
            {
                continue;
            }

            sent = true;
            logger.LogInformation(
                "Step window start fired {auction_id} {starts_at} {task_id} {facts_created} {announced_created} {announced_suppressed}",
                auctionId,
                task.StartsAt,
                task.TaskId,
                result.Facts.Started.Created,
                result.Facts.Announced.Created,
                result.Facts.Announced.Suppressed);
        }

        await Settle(auctionId, token);
        return sent;
    }

    /// <summary>Пробуждение по reminder'у ведёт в тот же путь, что и sweeper.</summary>
    public Task ReceiveReminder(string reminderName, TickStatus status) => FireDue();

    private DateTimeOffset Now() => clock.GetUtcNow();

    /// <summary>
    /// Приводит reminder к ближайшему живому моменту и исполняет наступивший:
    /// ждать reminder'а нельзя, наступившее исполняют немедленно.
    /// </summary>
    private async Task Settle(Guid auctionId, CancellationToken token)
    {
        var next = await tasks.NextDue(auctionId, token);
        if (next is not { } moment)
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
