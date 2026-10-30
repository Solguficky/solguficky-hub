namespace Notifications.Reminders;

/// <summary>Что делать с заданием напоминания о счёте.</summary>
public enum InvoiceReminderAction
{
    /// <summary>Ничего: живого задания нет и создавать нечего.</summary>
    None,

    /// <summary>Завести задание на указанный момент.</summary>
    Create,

    /// <summary>Живое задание уже описывает этот момент.</summary>
    Keep,

    /// <summary>Счёт оплачен: живое задание снимается.</summary>
    Cancel,
}

/// <summary>
/// Решение по заданию. <see cref="DueAt" /> заполнен только для
/// <see cref="InvoiceReminderAction.Create" />.
/// </summary>
public sealed record InvoiceReminderDecision(InvoiceReminderAction Action, DateTimeOffset? DueAt)
{
    public static readonly InvoiceReminderDecision None = new(InvoiceReminderAction.None, null);
    public static readonly InvoiceReminderDecision Keep = new(InvoiceReminderAction.Keep, null);
    public static readonly InvoiceReminderDecision Cancel = new(InvoiceReminderAction.Cancel, null);
}

/// <summary>
/// Чистое ядро напоминания о счёте: по текущему заданию, состоянию счёта и
/// запрошенному моменту решает, что со строкой делать. Ни базы, ни Orleans,
/// ни часов.
/// </summary>
/// <remarks>
/// При переносе общего срока живое задание заменяется. История старого срока
/// не мешает создать момент нового срока; повтор того же момента идемпотентен.
/// </remarks>
public static class InvoiceReminderPlan
{
    /// <summary>
    /// Решение по одному виду момента.
    /// </summary>
    /// <param name="liveDueAt">
    /// Момент, который описывает живое (запланированное) задание, либо
    /// <c>null</c>, если живого задания нет.
    /// </param>
    /// <param name="everCreated">
    /// Задание по этому счёту и виду уже было: сработало или было снято. Второго
    /// напоминания на тот же вид не будет.
    /// </param>
    /// <param name="requestedDueAt">
    /// Момент, в который напоминание должно сработать, либо <c>null</c>, если
    /// напоминать не о чем: счёт не выставлен или его момент не вычислен.
    /// </param>
    /// <param name="settled">
    /// Счёт оплачен: напоминать больше не о чем, а живые задания снимаются.
    /// </param>
    public static InvoiceReminderDecision Decide(
        DateTimeOffset? liveDueAt,
        bool everCreated,
        DateTimeOffset? requestedDueAt,
        bool settled)
    {
        if (settled)
        {
            // Счёт оплачен: живые задания снимаются, новых не заводим.
            return liveDueAt is null ? InvoiceReminderDecision.None : InvoiceReminderDecision.Cancel;
        }

        if (requestedDueAt is not { } requested)
        {
            // Момент мог уже наступить: живое задание исполнит Settle, а не отменит применение реплики.
            return InvoiceReminderDecision.None;
        }

        // Повторный снимок того же срока не меняет живое задание.
        if (liveDueAt == requested)
        {
            return InvoiceReminderDecision.Keep;
        }

        // Этот момент данного срока уже сработал: повтор не нужен.
        if (everCreated)
        {
            return InvoiceReminderDecision.None;
        }

        return new InvoiceReminderDecision(InvoiceReminderAction.Create, requested);
    }
}

/// <summary>
/// Моменты напоминаний о счёте: за 24 часа, за 12 часов и за час до срока
/// оплаты (PER-726).
/// </summary>
/// <remarks>
/// Моменты считаются из неизменных значений счёта: момента выставления и срока
/// оплаты. Срок оплаты Auction считает от продажи, а счёт выставляется сразу
/// за ней, поэтому при сроке в сутки момент «за 24 часа» приходится на саму
/// продажу — рядом с вестью о покупке. Такой момент пропускается: напоминание
/// уместно только позже выставления с допуском.
/// </remarks>
public static class InvoiceReminderMoments
{
    /// <summary>
    /// Момент напоминания по виду. <c>null</c> — момент пропускается: он не
    /// позже выставления счёта с допуском <paramref name="issueGap" /> или не
    /// раньше срока оплаты.
    /// </summary>
    public static DateTimeOffset? For(
        InvoiceReminderKind kind,
        DateTimeOffset issuedAt,
        DateTimeOffset paymentDueAt,
        TimeSpan issueGap)
    {
        var moment = paymentDueAt - InvoiceReminderKinds.Lead(kind);

        if (moment <= issuedAt + issueGap)
        {
            return null;
        }

        return moment >= paymentDueAt ? null : moment;
    }
}
