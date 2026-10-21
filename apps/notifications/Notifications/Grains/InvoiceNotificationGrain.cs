using Microsoft.Extensions.Options;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Npgsql;

namespace Notifications.Grains;

/// <inheritdoc cref="IInvoiceNotificationGrain" />
public sealed class InvoiceNotificationGrain(
    InvoiceReminderTaskStore tasks,
    NpgsqlDataSource source,
    FactTelemetry facts,
    IOptions<InvoiceReminderOptions> options,
    TimeProvider clock,
    ILogger<InvoiceNotificationGrain> logger) : Grain, IInvoiceNotificationGrain, IRemindable
{
    /// <summary>Имя reminder'а. Одно на грин: заданий у счёта два, а грин один.</summary>
    private const string ReminderName = "invoice-reminder";

    /// <summary>
    /// Период повтора reminder'а. Одноразовых reminder'ов Orleans не знает, а
    /// минимальный период ограничен снизу, поэтому напоминание снимается явно
    /// после успешного срабатывания; до тех пор повтор работает retry.
    /// </summary>
    private static readonly TimeSpan ReminderRetryPeriod = TimeSpan.FromHours(1);

    /// <summary>
    /// Моменты напоминания о счёте: после победы и перед сроком оплаты.
    /// </summary>
    private static readonly InvoiceReminderKind[] Kinds = [InvoiceReminderKind.AfterWin, InvoiceReminderKind.BeforeDue];

    private InvoiceReminderOptions Options => options.Value;

    public async Task ApplyReplica()
    {
        if (Key() is not { } invoiceId)
        {
            // Ключ не счёт — задания у такого ключа быть не может.
            return;
        }

        // Реплика читается здесь, внутри хода грина: ход у счёта один, поэтому
        // вызов, пришедший позже, всегда видит не более старый снимок. Счёта,
        // которого реплика не знает, для напоминания нет.
        var replica = await InvoiceReplicaStore.Read(source, invoiceId, CancellationToken.None);

        await Apply(invoiceId, replica, CancellationToken.None);
    }

    public async Task<bool> FireDue()
    {
        if (Key() is not { } invoiceId)
        {
            await Sleep();
            return false;
        }

        var token = CancellationToken.None;

        var live = await tasks.Due(invoiceId, Now(), token);

        if (live is null)
        {
            // Наступившего задания нет: живое задание может ждать свой момент —
            // его будить рано, а будить больше некого. Reminder мог пережить
            // снятие задания, если силос умер между двумя записями.
            await Settle(invoiceId, token);
            return false;
        }

        var result = await tasks.Fire(live, Now(), token);

        if (result.Outcome == InvoiceFireOutcome.Sent)
        {
            facts.Record(NotificationFacts.TypeOf(live.Kind), result.Facts);
            logger.LogInformation(
                "Invoice reminder fired {kind} {invoice_id} {task_id} {facts_created} {facts_suppressed}",
                live.Kind,
                invoiceId,
                live.TaskId,
                result.Facts.Created,
                result.Facts.Suppressed);
        }

        // Reminder живёт, пока жив хоть один момент: после срабатывания первого
        // второй ещё ждёт своего.
        await Settle(invoiceId, token);

        return result.Outcome == InvoiceFireOutcome.Sent;
    }

    /// <summary>Пробуждение по reminder'у ведёт в тот же путь, что и sweeper.</summary>
    public Task ReceiveReminder(string reminderName, TickStatus status) => FireDue();

    private async Task Apply(Guid invoiceId, InvoiceReplica? replica, CancellationToken token)
    {
        // Оплаченный счёт напоминаний не имеет: живые задания снимаются, а
        // новые не заводятся. Неоплаченный, о котором реплика ничего не знает,
        // — тоже: момент выставления неизвестен, а без него напоминать не о чем.
        var settled = replica is null || replica.Status != InvoiceStatus.AwaitingPayment;

        // Срок оплаты прошёл, а счёт не оплачен: напоминать уже не о чем, и
        // весть о неоплаченном счёте после срока — шум.
        var overdue = replica is { } current && current.PaymentDueAt <= Now();

        var creates = new List<(InvoiceReminderKind Kind, DateTimeOffset DueAt)>();
        var cancel = false;

        foreach (var kind in Kinds)
        {
            var existing = await tasks.Read(invoiceId, kind, token);
            var live = existing is { Live: true } ? existing.DueAt : (DateTimeOffset?)null;
            var requested = settled || overdue ? null : Moment(kind, replica!);

            var decision = InvoiceReminderPlan.Decide(live, existing is not null, requested, settled || overdue);

            switch (decision.Action)
            {
                case InvoiceReminderAction.Create:
                    creates.Add((kind, decision.DueAt!.Value));
                    break;

                case InvoiceReminderAction.Cancel:
                    cancel = true;
                    break;

                case InvoiceReminderAction.Keep:
                case InvoiceReminderAction.None:
                default:
                    continue;
            }

            logger.LogInformation("Invoice reminder task {action} {kind} {invoice_id} {due_at}", decision.Action,
                kind, invoiceId, decision.DueAt);
        }

        // Решения по обоим видам применяются одной транзакцией: два задания —
        // два момента одного напоминания, и падение между их записями оставило
        // бы счёт без второго момента навсегда.
        await tasks.Apply(invoiceId, creates, cancel, Reason(replica, settled, overdue), Now(), token);

        await Settle(invoiceId, token);
    }

    /// <summary>Причина снятия заданий: она встаёт в строку и читается глазами.</summary>
    private static string Reason(InvoiceReplica? replica, bool settled, bool overdue) =>
        settled ? (replica is null ? "invoice is unknown" : "invoice paid")
        : "payment deadline passed";

    private DateTimeOffset Now() => clock.GetUtcNow();

    /// <summary>Ключ грина как идентификатор счёта; <c>null</c> — ключ счётом не является.</summary>
    private Guid? Key() =>
        Guid.TryParse(this.GetPrimaryKeyString(), out var invoiceId) ? invoiceId : null;

    /// <summary>
    /// Приводит reminder'а к ближайшему живому моменту и исполняет наступивший:
    /// ждать reminder'а нельзя, наступившее исполняют немедленно.
    /// </summary>
    private async Task Settle(Guid invoiceId, CancellationToken token)
    {
        var due = await NextDue(invoiceId, token);
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

    /// <summary>Ближайший момент живых заданий счёта.</summary>
    private async Task<DateTimeOffset?> NextDue(Guid invoiceId, CancellationToken token)
    {
        var live = new List<DateTimeOffset>();
        foreach (var kind in Kinds)
        {
            var task = await tasks.Read(invoiceId, kind, token);
            if (task is { Live: true })
            {
                live.Add(task.DueAt);
            }
        }

        return live.Count == 0 ? null : live.Min();
    }

    /// <summary>
    /// Момент напоминания по виду. Момент приводится к точности хранения один раз
    /// и здесь: дальше он и сравнивается с прочитанным из базы, и пишется в неё.
    /// </summary>
    /// <remarks>
    /// Момент выставления знает только факт выставления счёта. Пока он не
    /// пришёл, напоминать не о чем, и задание не заводится.
    ///
    /// Напоминание приходит только пока срок оплаты не прошёл: момент позже
    /// срока — шум, и релей снял бы такой факт по сроку годности, оставив
    /// задание сработавшим. Срок оплаты Auction считает от продажи, а счёт
    /// выставляется позже продажи, поэтому при коротком сроке напоминание могло
    /// бы оказаться позже него.
    /// </remarks>
    private DateTimeOffset? Moment(InvoiceReminderKind kind, InvoiceReplica replica)
    {
        if (replica.IssuedAt is not { } issuedAt)
        {
            return null;
        }

        var moment = InvoiceReminderMoments.For(kind, issuedAt, replica.PaymentDueAt, Options.FirstLead,
            Options.DueLead, Options.MinGap);

        return moment is { } value ? ReminderPlan.ToStoredPrecision(value) : null;
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
