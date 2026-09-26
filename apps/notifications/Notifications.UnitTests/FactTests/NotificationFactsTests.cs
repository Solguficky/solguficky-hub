using Notifications.Facts;
using Notifications.Replica;
using Notifications.TestKit;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Форма адресного факта. Идентификатор, момент и срок годности приходят
/// снаружи, поэтому сообщение проверяется целиком, без базы и часов.
/// </summary>
public class NotificationFactsTests
{
    private static readonly Guid NotificationId = Guid.CreateVersion7();
    private static readonly Guid RecipientId = Guid.CreateVersion7();
    private static readonly DateTimeOffset Now = new(2026, 9, 25, 10, 15, 30, TimeSpan.Zero);
    private static readonly DateTimeOffset NotAfter = Now.AddHours(24);

    [Fact]
    public void MeetupPublished_FirstPublication_AddressesOneRecipientWithCard()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, title: "Пятничная"));

        var notification = NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.NotificationId.ShouldBe(NotificationId.ToString());
        notification.RecipientId.ShouldBe(RecipientId.ToString());
        notification.CreatedAt.ShouldBe("2026-09-25T10:15:30Z");
        notification.Cause.MeetupEventId.ShouldBe(fact.EventId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupPublished);
        notification.MeetupPublished.Meetup.ShouldBe(fact.Card);
        notification.MeetupPublished.Meetup.Title.ShouldBe("Пятничная");
    }

    /// <summary>
    /// Готового текста и chat_id в контракте нет по построению; чужой
    /// request_id сервис своим не подменяет.
    /// </summary>
    [Fact]
    public void MeetupPublished_NoRequestId_LeavesRequestIdUnset()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2));

        var notification = NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.HasRequestId.ShouldBeFalse();
    }

    /// <summary>
    /// Срок годности ставится каждому типу: весть, пролежавшая в очереди
    /// дольше срока, устарела, какой бы она ни была.
    /// </summary>
    [Fact]
    public void When_AnyMeetupFactIsBuilt_Expect_NotAfterCarriedAsUtcInstant()
    {
        var published = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2));
        var changed = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));
        var material = Decode(EventFactory.Material(EventFactory.NewId(), version: 3, EventFactory.NewId(), "Фото"));
        var hidden = EventFactory.Meetup(EventFactory.NewId(), version: 3);
        hidden.State.Visibility = Meetups.V1.MeetupVisibility.Hidden;
        hidden.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();

        Notification[] notifications =
        [
            NotificationFacts.MeetupPublished(NotificationId, RecipientId, published, Now, NotAfter),
            NotificationFacts.MeetupChanged(NotificationId, RecipientId, changed, [MeetupAspect.Title], Now, NotAfter),
            NotificationFacts.MeetupMaterial(NotificationId, RecipientId, material, Now, NotAfter),
            NotificationFacts.MeetupUnpublished(NotificationId, RecipientId, Decode(hidden), Now, NotAfter),
        ];

        notifications.ShouldAllBe(notification => notification.NotAfter == "2026-09-26T10:15:30Z");
    }

    [Fact]
    public void MeetupPublished_EventRequestId_CarriedUnchanged()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, requestId: "req-7"));

        NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now, NotAfter).RequestId.ShouldBe("req-7");
    }

    [Fact]
    public void MeetupPublished_NotFirstPublication_Throws()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3);
        message.MeetupRepublished = new Meetups.V1.MeetupRepublished();

        Should.Throw<ArgumentException>(() =>
            NotificationFacts.MeetupPublished(NotificationId, RecipientId, Decode(message), Now, NotAfter));
    }

    /// <summary>
    /// Карточка в факте — копия, а не ссылка: один повод разворачивается на
    /// многих получателей, и правка одного сообщения не должна задевать другие.
    /// </summary>
    [Fact]
    public void MeetupPublished_TwoRecipients_ShareNoCardInstance()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2));

        var first = NotificationFacts.MeetupPublished(Guid.CreateVersion7(), RecipientId, fact, Now, NotAfter);
        var second = NotificationFacts.MeetupPublished(Guid.CreateVersion7(), Guid.CreateVersion7(), fact, Now, NotAfter);

        ReferenceEquals(first.MeetupPublished.Meetup, second.MeetupPublished.Meetup).ShouldBeFalse();
    }

    [Fact]
    public void MeetupChanged_Aspects_CarriedWithCurrentCard()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3, title: "Перенесённая", requestId: "req-9");
        message.MeetupChanged = new Meetups.V1.MeetupChanged();
        var fact = Decode(message);

        var notification = NotificationFacts.MeetupChanged(
            NotificationId, RecipientId, fact, [MeetupAspect.Title, MeetupAspect.Schedule], Now, NotAfter);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupChanged);
        notification.MeetupChanged.Meetup.Title.ShouldBe("Перенесённая");
        notification.MeetupChanged.ChangedAspects.ShouldBe([MeetupAspect.Title, MeetupAspect.Schedule]);
        notification.Cause.MeetupEventId.ShouldBe(fact.EventId.ToString());
        notification.RequestId.ShouldBe("req-9");
    }

    [Fact]
    public void MeetupChanged_EmptyChange_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() =>
            NotificationFacts.MeetupChanged(NotificationId, RecipientId, fact, [], Now, NotAfter));
    }

    [Fact]
    public void MeetupMaterial_AttachedMaterial_CarriesIdAndTitle()
    {
        var materialId = EventFactory.NewId();
        var fact = Decode(EventFactory.Material(EventFactory.NewId(), version: 3, materialId, "Фото"));

        var notification = NotificationFacts.MeetupMaterial(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupMaterial);
        notification.MeetupMaterial.MaterialId.ShouldBe(materialId);
        notification.MeetupMaterial.MaterialTitle.ShouldBe("Фото");
        notification.MeetupMaterial.Meetup.ShouldBe(fact.Card);
    }

    [Fact]
    public void MeetupMaterial_NotMaterialOccasion_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() => NotificationFacts.MeetupMaterial(NotificationId, RecipientId, fact, Now, NotAfter));
    }

    [Fact]
    public void MeetupUnpublished_Unpublication_CarriesCard()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3);
        message.State.Visibility = Meetups.V1.MeetupVisibility.Hidden;
        message.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();
        var fact = Decode(message);

        var notification = NotificationFacts.MeetupUnpublished(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupUnpublished);
        notification.MeetupUnpublished.Meetup.ShouldBe(fact.Card);
    }

    [Fact]
    public void MeetupUnpublished_NotUnpublication_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() => NotificationFacts.MeetupUnpublished(NotificationId, RecipientId, fact, Now, NotAfter));
    }

    [Fact]
    public void MeetupPublishedByDefault_NoPreferenceRow_IsEnabled() =>
        NotificationFacts.MeetupPublishedByDefault.ShouldBeTrue();

    [Fact]
    public void HubCircle_PublicRole_IsOutside() =>
        NotificationFacts.HubCircle.ShouldBe(["admin", "maintainer", "member"], ignoreOrder: true);

    /// <summary>
    /// Повод напоминания — задание, а не событие: ссылка на него, карточка на
    /// момент срабатывания и никакой чужой цепочки.
    /// </summary>
    [Fact]
    public void MeetupReminder_FiredTask_ReferencesTaskAndCarriesCard()
    {
        var taskId = Guid.CreateVersion7();
        var card = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, title: "Пятничная")).Card;
        var startsAt = Now.AddHours(24);

        var notification = NotificationFacts.MeetupReminder(NotificationId, RecipientId, taskId, card, Now, startsAt);

        notification.RecipientId.ShouldBe(RecipientId.ToString());
        notification.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupReminder);
        notification.MeetupReminder.Meetup.ShouldBe(card);
        notification.NotAfter.ShouldBe("2026-09-26T10:15:30Z");
        notification.HasRequestId.ShouldBeFalse();
    }

    private static MeetupFact Decode(Meetups.V1.MeetupEvent message) =>
        ReplicaMapping.Meetup(EventFactory.Bytes(message))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<MeetupFact>();
}
