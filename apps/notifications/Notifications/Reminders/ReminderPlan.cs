namespace Notifications.Reminders;

/// <summary>Что делать с заданием напоминания для сходки.</summary>
public enum ReminderAction
{
    /// <summary>Ничего: живого задания нет и создавать нечего.</summary>
    None,

    /// <summary>Завести задание на указанный момент.</summary>
    Create,

    /// <summary>Живое задание уже описывает этот момент.</summary>
    Keep,

    /// <summary>Момент начала сдвинулся: прежнее задание замещается новым.</summary>
    Supersede,

    /// <summary>Момента начала больше нет: живое задание снимается.</summary>
    Cancel,
}

/// <summary>
/// Решение по заданию. <see cref="DueAt" /> и <see cref="StartsAt" /> заполнены
/// только для <see cref="ReminderAction.Create" /> и
/// <see cref="ReminderAction.Supersede" /> — там, где строку предстоит написать.
/// </summary>
public sealed record ReminderDecision(ReminderAction Action, DateTimeOffset? StartsAt, DateTimeOffset? DueAt)
{
    public static readonly ReminderDecision None = new(ReminderAction.None, null, null);
    public static readonly ReminderDecision Keep = new(ReminderAction.Keep, null, null);
    public static readonly ReminderDecision Cancel = new(ReminderAction.Cancel, null, null);
}

/// <summary>
/// Чистое ядро напоминания: по текущему состоянию задания и актуальному
/// расписанию решает, что со строкой делать. Ни базы, ни Orleans, ни часов.
/// </summary>
/// <remarks>
/// Часов здесь нет намеренно, и это не упущение. Решение «завести, оставить,
/// заместить или снять» зависит только от того, совпадает ли момент живого
/// задания с моментом расписания; «наступило ли уже» — отдельный вопрос, и его
/// задаёт тот, кто исполняет задание, а не тот, кто его планирует. Из-за этого
/// разделения перенос в прошлое не требует особой ветки: задание создаётся с
/// уже наступившим <c>due_at</c>, и ближайший проход исполняет его немедленно —
/// ровно то, чего требует ADR-028.
/// </remarks>
public static class ReminderPlan
{
    /// <summary>
    /// Приводит момент к точности, в которой он переживёт запись: UTC и
    /// микросекунды.
    /// </summary>
    /// <remarks>
    /// Не косметика, а условие корректности сравнения. <c>DateTimeOffset</c>
    /// считает в тактах по сто наносекунд, а <c>timestamptz</c> хранит
    /// микросекунды, поэтому записанный и прочитанный обратно момент
    /// отличается от исходного остатком до микросекунды. Без приведения
    /// «момент не менялся» не выполняется никогда: каждая правка сходки
    /// сравнивала бы обрезанное значение из базы с необрезанным входным,
    /// признавала бы их разными и пересоздавала бы напоминание.
    ///
    /// Приведение к UTC здесь по той же причине: из базы момент возвращается
    /// в UTC, и равенство не должно зависеть от смещения на входе.
    /// </remarks>
    public static DateTimeOffset ToStoredPrecision(DateTimeOffset moment)
    {
        var utc = moment.ToUniversalTime();

        return new DateTimeOffset(utc.Ticks - (utc.Ticks % TimeSpan.TicksPerMicrosecond), TimeSpan.Zero);
    }

    /// <summary>
    /// Решение по одной сходке. Оба момента ожидаются уже приведёнными
    /// <see cref="ToStoredPrecision" />.
    /// </summary>
    /// <param name="liveStartsAt">
    /// Момент начала, который описывает живое (запланированное) задание, либо
    /// <c>null</c>, если живого задания нет.
    /// </param>
    /// <param name="firedForRequestedStart">
    /// По запрошенному моменту напоминание уже срабатывало. Нужно для возврата
    /// сходки из публикации: снятая и возвращённая сходка получает задание
    /// заново, но только если по этому моменту оно ещё не срабатывало —
    /// иначе возврат рассылал бы одно и то же напоминание повторно.
    /// </param>
    /// <param name="requestedStartsAt">
    /// Момент начала из актуального расписания, либо <c>null</c>, если его нет:
    /// сходка отменена, снята с публикации или расписание потеряло время.
    /// </param>
    /// <param name="lead">За сколько до начала напоминать.</param>
    public static ReminderDecision Decide(
        DateTimeOffset? liveStartsAt,
        bool firedForRequestedStart,
        DateTimeOffset? requestedStartsAt,
        TimeSpan lead)
    {
        if (requestedStartsAt is not { } requested)
        {
            // Времени начала нет. День без времени задания не порождает —
            // сервис не подставляет полночь, — а уже созданное снимает.
            return liveStartsAt is null ? ReminderDecision.None : ReminderDecision.Cancel;
        }

        if (liveStartsAt == requested)
        {
            // Правка, момента не тронувшая, нового задания не порождает.
            return ReminderDecision.Keep;
        }

        if (firedForRequestedStart)
        {
            // По запрошенному моменту напоминание уже уходило, и второго по
            // нему быть не должно. Новое напоминание порождает перенос **на
            // новую дату**, а не возврат на ту, по которой уже напомнили.
            //
            // Живое задание здесь описывает другой момент — то есть сходку
            // успели увести и вернуть обратно. Оно снимается: расписание его
            // момента больше не подтверждает, а создавать взамен нечего.
            return liveStartsAt is null ? ReminderDecision.None : ReminderDecision.Cancel;
        }

        return liveStartsAt is null
            ? new ReminderDecision(ReminderAction.Create, requested, requested - lead)
            : new ReminderDecision(ReminderAction.Supersede, requested, requested - lead);
    }
}
