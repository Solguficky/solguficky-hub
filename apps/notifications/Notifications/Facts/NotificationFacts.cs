using Notifications.Domain;
using Notifications.Replica;
using Notifications.V1;

namespace Notifications.Facts;

/// <summary>
/// Адресный факт в форме контракта <c>notifications.v1.Notification</c>. Чистые
/// функции: идентификатор, момент порождения и срок годности приходят снаружи,
/// поэтому форма сообщения проверяется на L0, без базы и часов.
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
    public const string MeetupReminderType = "meetup_reminder";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupEventCause = "meetup_event";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string ReminderTaskCause = "reminder_task";

    /// <summary>
    /// Причины снятия неотправленного факта в колонке
    /// <c>notification.withdrawal_reason</c>: сходку отменили, пока факт ждал
    /// релея, либо он пролежал в очереди дольше срока годности.
    /// </summary>
    public const string WithdrawnOnCancellation = "meetup_cancelled";

    /// <inheritdoc cref="WithdrawnOnCancellation" />
    public const string WithdrawnExpired = "expired";

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

    /// <summary>Категория напоминания. Единственная выключенная по умолчанию.</summary>
    public const NotificationCategory MeetupReminderCategory = NotificationCategory.MeetupReminder;

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
    public static Notification MeetupPublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.FirstPublication);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupPublished = new V1.MeetupPublished { Meetup = fact.Card.Clone() };

        return notification;
    }

    /// <summary>Факт «изменение сведений или состояния» одному получателю.</summary>
    /// <param name="changed">Аспекты, отличающиеся от реплики. Пустой список поводом не является.</param>
    public static Notification MeetupChanged(
        Guid notificationId,
        Guid recipientId,
        MeetupFact fact,
        IReadOnlyList<MeetupAspect> changed,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        if (changed.Count == 0)
        {
            throw new ArgumentException("an empty change is not a cause of a notification", nameof(changed));
        }

        var body = new V1.MeetupChanged { Meetup = fact.Card.Clone() };
        body.ChangedAspects.Add(changed);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupChanged = body;

        return notification;
    }

    /// <summary>Факт «новый материал» одному получателю.</summary>
    /// <param name="fact">Событие появления материала.</param>
    public static Notification MeetupMaterial(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.MaterialAttached);
        var material = fact.Material
            ?? throw new ArgumentException("the event names no material", nameof(fact));

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
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
    public static Notification MeetupUnpublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.Unpublication);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupUnpublished = new V1.MeetupUnpublished { Meetup = fact.Card.Clone() };

        return notification;
    }

    /// <summary>Напоминание о сходке одному получателю.</summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="card">Карточка на момент срабатывания.</param>
    /// <param name="notAfter">
    /// Момент начала сходки: напоминание, не ушедшее до начала, уже шум, и релей
    /// снимет его по сроку.
    /// </param>
    /// <remarks>
    /// <c>request_id</c> у факта нет: у срабатывания таймера нет цепочки, которую
    /// начал человек, а своего id Notifications не рождает
    /// (docs/architecture/integration.md, «Notifications NATS»).
    /// </remarks>
    public static Notification MeetupReminder(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        MeetupCard card,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.MeetupReminder = new V1.MeetupReminder { Meetup = card.Clone() };

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

    // Общее для всех типов: получатель, момент, срок годности и ссылка на
    // событие-повод. Срок ставится каждому типу: вести о сходке, пролежавшей
    // в очереди дольше срока, доставлять уже не нужно (FactOptions.StaleAfter).
    // Карточка копируется в каждый факт: один повод разворачивается на многих
    // получателей, и правка одного сообщения не должна задевать другие.
    //
    // Факт из события переносит его request_id без изменений и своего не
    // рождает (docs/architecture/integration.md, «Notifications NATS»).
    private static Notification Addressed(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter) =>
        Envelope(
            notificationId,
            recipientId,
            new Cause { MeetupEventId = fact.EventId.ToString() },
            fact.RequestId,
            now,
            notAfter);

    private static Notification Envelope(
        Guid notificationId,
        Guid recipientId,
        Cause cause,
        string? requestId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = Instant(now),
            NotAfter = Instant(notAfter),
            Cause = cause,
        };

        if (requestId is not null)
        {
            notification.RequestId = requestId;
        }

        return notification;
    }
}
