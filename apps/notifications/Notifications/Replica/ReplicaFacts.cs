namespace Notifications.Replica;

/// <summary>
/// Разобранное чужое событие: конверт и снимок в тех значениях, которые
/// хранит реплика.
/// </summary>
/// <remarks>
/// Идентификаторы и момент уже проверены: до хранилища доходит только то, что
/// ему можно записать, а всё остальное стало <see cref="Decoded.Poison" />.
/// </remarks>
public abstract record ReplicaEvent(Guid EventId, Guid AggregateId, long Version, DateTimeOffset OccurredAt)
{
    /// <summary>Источник факта — строка <c>consumed_event.source</c>.</summary>
    public abstract string Source { get; }
}

/// <summary>Факт о сходке из Meetups.</summary>
public sealed record MeetupFact(
    Guid EventId,
    Guid MeetupId,
    long Version,
    DateTimeOffset OccurredAt,
    MeetupReplicaState State) : ReplicaEvent(EventId, MeetupId, Version, OccurredAt)
{
    public override string Source => ReplicaFeeds.MeetupsSource;
}

/// <summary>Снимок сходки в колонках <c>meetup_replica</c>.</summary>
public sealed record MeetupReplicaState(
    Guid Author,
    string Title,
    string Description,
    string Venue,
    string Kind,
    string CalendarLink,
    string Lifecycle,
    string Visibility,
    DateTimeOffset? FirstPublishedAt,
    ScheduleColumns Schedule);

/// <summary>
/// Расписание в той же раскладке, что у владельца: форма, точность и локальные
/// дата и время без зоны.
/// </summary>
public sealed record ScheduleColumns(
    string Form,
    string? Precision,
    DateOnly? StartDate,
    TimeOnly? StartTime,
    DateOnly? EndDate,
    TimeOnly? EndTime)
{
    public static readonly ScheduleColumns NoDate = new("no_date", null, null, null, null, null);
}

/// <summary>Факт о допуске человека из Identity.</summary>
public sealed record IdentityFact(
    Guid EventId,
    Guid IdentityId,
    long Version,
    DateTimeOffset OccurredAt,
    IReadOnlyList<string> GlobalRoles,
    bool Blocked) : ReplicaEvent(EventId, IdentityId, Version, OccurredAt)
{
    public override string Source => ReplicaFeeds.IdentitySource;
}

/// <summary>Итог разбора сообщения шины.</summary>
public abstract record Decoded
{
    private Decoded()
    {
    }

    /// <summary>Сообщение разобрано и может быть применено.</summary>
    public sealed record Fact(ReplicaEvent Event) : Decoded;

    /// <summary>
    /// Сообщение нарушает контракт. Повтор его не исправит, поэтому оно не
    /// возвращается в шину, а снимается с доставки.
    /// </summary>
    public sealed record Poison(string Reason) : Decoded;
}

/// <summary>Что применение сделало с репликой.</summary>
public enum ReplicaOutcome
{
    /// <summary>Снимок новее того, что было, и записан.</summary>
    Applied,

    /// <summary>Это событие уже обработано: ключ дедупликации записан раньше.</summary>
    Duplicate,

    /// <summary>
    /// Событие новое, но реплика уже держит версию не старше: ключ записан,
    /// реплика не тронута.
    /// </summary>
    Stale,
}
