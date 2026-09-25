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
    public const string MeetupEventCause = "meetup_event";

    /// <summary>
    /// Категория, которой человек отказывается от «новой сходки». Настраивается
    /// только глобально: подписаться на ещё не созданную сходку нельзя.
    /// </summary>
    public const NotificationCategory MeetupPublishedCategory = NotificationCategory.MeetupPublished;

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
    /// <param name="fact">Событие первой публикации: карточка обязана быть в нём.</param>
    public static Notification MeetupPublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now)
    {
        var card = fact.FirstPublication
            ?? throw new ArgumentException("the event is not a first publication", nameof(fact));

        var notification = new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = Instant(now),
            Cause = new Cause { MeetupEventId = fact.EventId.ToString() },
            MeetupPublished = new V1.MeetupPublished { Meetup = card.Clone() },

            // not_after не ставится: у новой сходки нет момента, после которого
            // весть о ней теряет смысл, а начало сходки — местное время без зоны,
            // и превращать его в момент значило бы решать за канал.
        };

        // Факт из события переносит его request_id без изменений и своего не
        // рождает (docs/architecture/integration.md, «Notifications NATS»).
        if (fact.RequestId is { } requestId)
        {
            notification.RequestId = requestId;
        }

        return notification;
    }

    /// <summary>RFC 3339 в UTC, как остальные моменты контрактов.</summary>
    public static string Instant(DateTimeOffset moment) =>
        moment.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", System.Globalization.CultureInfo.InvariantCulture);
}
