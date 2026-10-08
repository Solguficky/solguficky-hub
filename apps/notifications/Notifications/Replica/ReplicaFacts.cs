using Notifications.Facts;

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
/// <param name="RequestId">
/// Сквозной идентификатор цепочки из конверта; <c>null</c> — поля не было.
/// Факт, порождённый этим событием, переносит его без изменений.
/// </param>
/// <param name="Card">
/// Карточка сходки для адресного факта. Собрана из снимка события, а не из
/// реплики: запоздавшее событие реплику не трогает, но поводом остаётся, и
/// описывать оно обязано себя.
/// </param>
/// <param name="Occasion">Повод события в той мере, в какой он различает адресные факты.</param>
/// <param name="Material">Прикреплённый материал, если повод — его появление; иначе <c>null</c>.</param>
/// <param name="PerformedBy">
/// Человек, чья команда породила событие; <c>null</c> — человека не было
/// (публикация по расписанию) или поля не было. Адресатом факта он не
/// становится: о собственном действии человеку не сообщают.
/// </param>
public sealed record MeetupFact(
    Guid EventId,
    Guid MeetupId,
    long Version,
    DateTimeOffset OccurredAt,
    MeetupReplicaState State,
    Notifications.V1.MeetupCard Card,
    MeetupOccasion Occasion = MeetupOccasion.Other,
    string? RequestId = null,
    AttachedMaterial? Material = null,
    Guid? PerformedBy = null) : ReplicaEvent(EventId, MeetupId, Version, OccurredAt)
{
    public override string Source => ReplicaFeeds.MeetupsSource;
}

/// <summary>
/// Повод события Meetups, сведённый к тому, что различает адресные факты.
/// </summary>
/// <remarks>
/// Своего типа факта удостоены три повода. Остальные — правка, отмена,
/// проведение, возврат в публикацию, отложенная публикация, пустой oneof —
/// одинаковы: их факт, если он есть, вычисляется сравнением снимка с репликой,
/// а не выводится из повода (ADR-031).
/// </remarks>
public enum MeetupOccasion
{
    Other,

    /// <summary><c>meetup_published</c>: сходка стала видна впервые.</summary>
    FirstPublication,

    /// <summary><c>meetup_unpublished</c>: сходку сняли с публикации.</summary>
    Unpublication,

    /// <summary><c>meetup_material_attached</c>: у сходки появился материал.</summary>
    MaterialAttached,
}

/// <summary>Материал из коллекции снимка, названный поводом его появления.</summary>
public sealed record AttachedMaterial(Guid Id, string Title);

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
/// <param name="Role">
/// Активная роль-круг именем; <c>null</c> — круга нет: человек не допущен или
/// заблокирован.
/// </param>
/// <param name="Rights">
/// Права, которые вывел Identity, именами. Реплика пишет их как есть: из роли
/// права не выводятся (ADR-064, пункт 6).
/// </param>
/// <param name="OccasionRole">Выданная роль у <c>role_granted</c>; у остальных поводов пусто.</param>
/// <param name="OccasionQueue">Очередь заявки у заявки и допуска; у остальных поводов пусто.</param>
/// <param name="OccasionRight">Выданное право у <c>right_granted</c>; у остальных поводов пусто.</param>
public sealed record IdentityFact(
    Guid EventId,
    Guid IdentityId,
    long Version,
    DateTimeOffset OccurredAt,
    string? Role,
    IReadOnlyList<string> Rights,
    bool Blocked,
    IdentityOccasion Occasion = IdentityOccasion.Other,
    string? OccasionRole = null,
    AccessQueue? OccasionQueue = null,
    string? OccasionRight = null) : ReplicaEvent(EventId, IdentityId, Version, OccurredAt)
{
    public override string Source => ReplicaFeeds.IdentitySource;
}

/// <summary>
/// Повод события Identity, сведённый к тому, что различает адресные факты.
/// </summary>
/// <remarks>
/// Своего типа факта удостоены заявка, допуск по ней и выдача роли <c>admin</c>
/// (PER-468). Выдача других ролей, выдача права и блокировка различаются
/// потому, что закрывают заявку и снимают неотправленный факт о ней. Остальные
/// поводы, включая отзыв права и неизвестные этому потребителю, только двигают
/// реплику.
/// </remarks>
public enum IdentityOccasion
{
    Other,

    /// <summary><c>application_submitted</c>: открыта новая заявка в очередь.</summary>
    ApplicationSubmitted,

    /// <summary><c>application_admitted</c>: модератор очереди допустил по заявке.</summary>
    ApplicationAdmitted,

    /// <summary><c>role_granted</c>: роль стала активной.</summary>
    RoleGranted,

    /// <summary><c>right_granted</c>: право выдано отдельно от круга.</summary>
    RightGranted,

    /// <summary><c>profile_blocked</c>: человек заблокирован.</summary>
    ProfileBlocked,
}

/// <summary>Очередь заявки (ADR-064, пункт 12): очереди независимы.</summary>
public enum AccessQueue
{
    /// <summary>Заявка в сообщество: допуск выдаёт круг <c>member</c>.</summary>
    Community,

    /// <summary>Заявка на право <c>auction</c>.</summary>
    Auction,
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

/// <summary>Итог применения одного события: реплика и порождённые им факты.</summary>
/// <param name="Facts">Разворот повода; <c>null</c>, если событие поводом не было.</param>
public sealed record ReplicaApplication(ReplicaOutcome Outcome, ProducedFacts? Facts)
{
    public static readonly ReplicaApplication Duplicate = new(ReplicaOutcome.Duplicate, null);
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
