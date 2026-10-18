namespace Notifications.Reminders;

/// <summary>Что делать с заданием напоминания о дедлайне лота.</summary>
public enum LotReminderAction
{
    /// <summary>Ничего: живого задания нет и создавать нечего.</summary>
    None,

    /// <summary>Завести задание на указанный дедлайн.</summary>
    Create,

    /// <summary>Живое задание уже описывает этот дедлайн.</summary>
    Keep,

    /// <summary>Дедлайн сдвинулся: прежнее задание замещается новым.</summary>
    Supersede,

    /// <summary>Дедлайна больше нет или по лоту уже напоминали: живое задание снимается.</summary>
    Cancel,
}

/// <summary>
/// Решение по заданию. <see cref="Deadline" /> и <see cref="DueAt" /> заполнены
/// только для <see cref="LotReminderAction.Create" /> и
/// <see cref="LotReminderAction.Supersede" />.
/// </summary>
public sealed record LotReminderDecision(LotReminderAction Action, DateTimeOffset? Deadline, DateTimeOffset? DueAt)
{
    public static readonly LotReminderDecision None = new(LotReminderAction.None, null, null);
    public static readonly LotReminderDecision Keep = new(LotReminderAction.Keep, null, null);
    public static readonly LotReminderDecision Cancel = new(LotReminderAction.Cancel, null, null);
}

/// <summary>
/// Чистое ядро напоминания о лоте: по текущему заданию и дедлайну из реплики
/// решает, что со строкой делать. Ни базы, ни Orleans, ни часов.
/// </summary>
/// <remarks>
/// От <see cref="ReminderPlan" /> отличается одним правилом: сходке перенос
/// после срабатывания рождает новое напоминание (там это — обещание продукта),
/// а лоту не рождает ничего. Анти-снайп продлевает дедлайн в последние минуты,
/// и задание, пересозданное после срабатывания, прислало бы второе «остался
/// час» через минуту после первого (ADR-063, п.4). Поэтому здесь спрашивают не
/// «срабатывало ли по этому дедлайну», а «срабатывало ли вообще».
///
/// Часов здесь нет по той же причине, что у сходки, и это не упущение: решение
/// зависит только от того, совпадает ли дедлайн живого задания с дедлайном
/// реплики, а «наступило ли уже» задаёт исполнитель задания. Приведение момента
/// к точности хранения — <see cref="ReminderPlan.ToStoredPrecision" />.
/// </remarks>
public static class LotReminderPlan
{
    /// <summary>
    /// Решение по одному лоту. Оба момента ожидаются приведёнными
    /// <see cref="ReminderPlan.ToStoredPrecision" />.
    /// </summary>
    /// <param name="liveDeadline">Дедлайн, который описывает живое задание, либо <c>null</c>.</param>
    /// <param name="firedEver">По этому лоту напоминание уже срабатывало.</param>
    /// <param name="requestedDeadline">
    /// Дедлайн из реплики, либо <c>null</c>: лот без торгов, удержанный для
    /// финала или в конечном положении — напоминать не о чем.
    /// </param>
    /// <param name="lead">За сколько до дедлайна напоминать.</param>
    public static LotReminderDecision Decide(
        DateTimeOffset? liveDeadline,
        bool firedEver,
        DateTimeOffset? requestedDeadline,
        TimeSpan lead)
    {
        if (requestedDeadline is not { } requested)
        {
            return liveDeadline is null ? LotReminderDecision.None : LotReminderDecision.Cancel;
        }

        if (liveDeadline == requested)
        {
            return LotReminderDecision.Keep;
        }

        // Сработавшее задание продлением не пересоздаётся. Живого рядом с ним
        // быть не должно — но если он есть, он описывает уже не тот дедлайн.
        if (firedEver)
        {
            return liveDeadline is null ? LotReminderDecision.None : LotReminderDecision.Cancel;
        }

        return liveDeadline is null
            ? new LotReminderDecision(LotReminderAction.Create, requested, requested - lead)
            : new LotReminderDecision(LotReminderAction.Supersede, requested, requested - lead);
    }
}
