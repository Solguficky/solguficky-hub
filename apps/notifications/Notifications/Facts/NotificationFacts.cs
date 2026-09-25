using Notifications.Domain;
using Notifications.Replica;
using Notifications.V1;

namespace Notifications.Facts;

/// <summary>
/// Адресный факт в форме контракта <c>notifications.v1.Notification</c>. Чистые
/// функции: идентификатор и момент приходят снаружи, поэтому форма сообщения
/// проверяется на L0, без базы и часов.
/// </summary>
/// <remarks>
/// Готового текста и <c>chat_id</c> факт не несёт по построению: в сообщении
/// контракта для них нет полей, а рендеринг — дело канала (ADR-028).
/// </remarks>
public static class NotificationFacts
{
    /// <summary>Ключи типа и повода в таблице <c>notification</c>.</summary>
    public const string MeetupPublishedType = "meetup_published";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupChangedType = "meetup_changed";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupMaterialType = "meetup_material";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupUnpublishedType = "meetup_unpublished";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupEventCause = "meetup_event";

    /// <summary>
    /// Категория, которой человек отказывается от «новой сходки». Настраивается
    /// только глобально: подписаться на ещё не созданную сходку нельзя.
    /// </summary>
    public const NotificationCategory MeetupPublishedCategory = NotificationCategory.MeetupPublished;

    /// <summary>
    /// Категория изменений. Ей же подчинено служебное сообщение о снятии с
    /// публикации: продукт адресует его тем, у кого разрешена категория
    /// изменений состояния, а отдельной категории у снятия нет.
    /// </summary>
    public const NotificationCategory MeetupChangedCategory = NotificationCategory.MeetupChanged;

    /// <summary>Категория нового материала.</summary>
    public const NotificationCategory MeetupMaterialCategory = NotificationCategory.MeetupMaterial;

    /// <summary>
    /// Роли круга <c>member</c>, который принимает хаб (ADR-043). Identity
    /// отдаёт плоский набор активных ролей и вложенность не разворачивает,
    /// поэтому круг перечислен целиком. Роль <c>public</c> — внешний круг
    /// аукциона: сходок такой человек не видит, и новая сходка ему не положена.
    /// </summary>
    public static readonly IReadOnlyList<string> HubCircle = ["admin", "maintainer", "member"];

    /// <summary>Значение категории для человека без строки настроек.</summary>
    public static bool MeetupPublishedByDefault => NotificationCategories.DefaultEnabled(MeetupPublishedCategory);

    /// <summary>Факт «новая опубликованная сходка» одному получателю.</summary>
    /// <param name="fact">Событие первой публикации.</param>
    public static Notification MeetupPublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now)
    {
        Require(fact, MeetupOccasion.FirstPublication);

        var notification = Addressed(notificationId, recipientId, fact, now);
        notification.MeetupPublished = new V1.MeetupPublished { Meetup = fact.Card.Clone() };

        // not_after не ставится ни здесь, ни у остальных типов: у вести о
        // сходке нет момента, после которого она теряет смысл, а начало сходки —
        // местное время без зоны, и превращать его в момент значило бы решать
        // за канал.
        return notification;
    }

    /// <summary>Факт «изменение сведений или состояния» одному получателю.</summary>
    /// <param name="changed">Аспекты, отличающиеся от реплики. Пустой список поводом не является.</param>
    public static Notification MeetupChanged(
        Guid notificationId,
        Guid recipientId,
        MeetupFact fact,
        IReadOnlyList<MeetupAspect> changed,
        DateTimeOffset now)
    {
        if (changed.Count == 0)
        {
            throw new ArgumentException("an empty change is not a cause of a notification", nameof(changed));
        }

        var body = new V1.MeetupChanged { Meetup = fact.Card.Clone() };
        body.ChangedAspects.Add(changed);

        var notification = Addressed(notificationId, recipientId, fact, now);
        notification.MeetupChanged = body;

        return notification;
    }

    /// <summary>Факт «новый материал» одному получателю.</summary>
    /// <param name="fact">Событие появления материала.</param>
    public static Notification MeetupMaterial(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now)
    {
        Require(fact, MeetupOccasion.MaterialAttached);
        var material = fact.Material
            ?? throw new ArgumentException("the event names no material", nameof(fact));

        var notification = Addressed(notificationId, recipientId, fact, now);
        notification.MeetupMaterial = new V1.MeetupMaterial
        {
            Meetup = fact.Card.Clone(),
            MaterialId = material.Id.ToString(),
            MaterialTitle = material.Title,
        };

        return notification;
    }

    /// <summary>Служебное сообщение о снятии с публикации одному получателю.</summary>
    /// <param name="fact">Событие снятия с публикации.</param>
    public static Notification MeetupUnpublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now)
    {
        Require(fact, MeetupOccasion.Unpublication);

        var notification = Addressed(notificationId, recipientId, fact, now);
        notification.MeetupUnpublished = new V1.MeetupUnpublished { Meetup = fact.Card.Clone() };

        return notification;
    }

    /// <summary>RFC 3339 в UTC, как остальные моменты контрактов.</summary>
    public static string Instant(DateTimeOffset moment) =>
        moment.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private static void Require(MeetupFact fact, MeetupOccasion occasion)
    {
        if (fact.Occasion != occasion)
        {
            throw new ArgumentException($"the event is {fact.Occasion}, not {occasion}", nameof(fact));
        }
    }

    // Общее для всех типов: получатель, момент и ссылка на событие-повод.
    // Карточка копируется в каждый факт: один повод разворачивается на многих
    // получателей, и правка одного сообщения не должна задевать другие.
    private static Notification Addressed(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now)
    {
        var notification = new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = Instant(now),
            Cause = new Cause { MeetupEventId = fact.EventId.ToString() },
        };

        // Факт из события переносит его request_id без изменений и своего не
        // рождает (docs/architecture/integration.md, «Notifications NATS»).
        if (fact.RequestId is { } requestId)
        {
            notification.RequestId = requestId;
        }

        return notification;
    }
}
