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
/// От <see cref="LotReminderPlan" /> отличается отсутствием переноса: срок
/// оплаты задан при выставлении счёта и потом не меняется, поэтому момент
/// задания не меняется никогда, а второго напоминания на тот же счёт и вид не
/// заводится. Отсутствие переноса — не упущение, а следствие того, что сумма и
/// срок счёта неизменны.
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
            // Момент не вычислен: заводить нечего, а жить заданию без него
            // не с чем — но и снимать нечего, его и не было.
            return InvoiceReminderDecision.None;
        }

        // Живое задание описывает этот момент. Момент счёта неизменен, поэтому
        // расхождения быть не может, а пересчёт по смене настройки не делается:
        // так же, как у сходки и у лота.
        if (liveDueAt is not null)
        {
            return InvoiceReminderDecision.Keep;
        }

        // Задание по этому виду уже было: сработало или снято. Второго
        // напоминания на тот же вид не заводится.
        if (everCreated)
        {
            return InvoiceReminderDecision.None;
        }

        return new InvoiceReminderDecision(InvoiceReminderAction.Create, requested);
    }
}

/// <summary>
/// Моменты напоминаний о счёте: первый — после победы, второй — перед сроком
/// оплаты.
/// </summary>
/// <remarks>
/// Моменты считаются из неизменных значений счёта: момента выставления и срока
/// оплаты. Второй момент отводится от первого зазором: срок оплаты — любое
/// число секунд от суток до тридцати, поэтому «за сутки до срока» при
/// коротком сроке совпало бы с первым напоминанием или оказалось раньше него.
/// Срок не короче суток, поэтому зазор не выносит второе напоминание за срок
/// оплаты.
/// </remarks>
public static class InvoiceReminderMoments
{
    /// <summary>Первый момент: столько после победы.</summary>
    public static DateTimeOffset First(DateTimeOffset issuedAt, TimeSpan firstLead) => issuedAt + firstLead;

    /// <summary>
    /// Второй момент: столько до срока оплаты, но не раньше первого напоминания
    /// с зазором.
    /// </summary>
    public static DateTimeOffset Second(
        DateTimeOffset issuedAt,
        DateTimeOffset paymentDueAt,
        TimeSpan firstLead,
        TimeSpan dueLead,
        TimeSpan minGap)
    {
        var earliest = First(issuedAt, firstLead) + minGap;
        var moment = paymentDueAt - dueLead;

        return moment < earliest ? earliest : moment;
    }

    /// <summary>
    /// Момент напоминания по виду. <c>null</c> — напоминать не о чем: момент
    /// выставления неизвестен или напоминание пришлось бы позже срока оплаты.
    /// </summary>
    /// <remarks>
    /// Срок оплаты Auction считает от продажи, а счёт выставляется позже
    /// продажи, поэтому при коротком сроке напоминание могло бы оказаться позже
    /// него. Такое напоминание — шум, и релей снял бы такой факт по сроку
    /// годности, оставив задание сработавшим.
    /// </remarks>
    public static DateTimeOffset? For(
        InvoiceReminderKind kind,
        DateTimeOffset issuedAt,
        DateTimeOffset paymentDueAt,
        TimeSpan firstLead,
        TimeSpan dueLead,
        TimeSpan minGap)
    {
        var moment = kind switch
        {
            InvoiceReminderKind.AfterWin => First(issuedAt, firstLead),
            InvoiceReminderKind.BeforeDue => Second(issuedAt, paymentDueAt, firstLead, dueLead, minGap),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };

        return moment >= paymentDueAt ? null : moment;
    }
}
