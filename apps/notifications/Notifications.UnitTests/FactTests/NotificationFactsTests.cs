using Notifications.Facts;
using Notifications.Replica;
using Notifications.Tests;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Форма адресного факта. Идентификатор и момент приходят снаружи, поэтому
/// сообщение проверяется целиком, без базы и часов.
/// </summary>
public class NotificationFactsTests
{
    private static readonly Guid NotificationId = Guid.CreateVersion7();
    private static readonly Guid RecipientId = Guid.CreateVersion7();
    private static readonly DateTimeOffset Now = new(2026, 9, 25, 10, 15, 30, TimeSpan.Zero);

    [Fact]
    public void MeetupPublished_FirstPublication_AddressesOneRecipientWithCard()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, title: "Пятничная"));

        var notification = NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now);

        notification.NotificationId.ShouldBe(NotificationId.ToString());
        notification.RecipientId.ShouldBe(RecipientId.ToString());
        notification.CreatedAt.ShouldBe("2026-09-25T10:15:30Z");
        notification.Cause.MeetupEventId.ShouldBe(fact.EventId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupPublished);
        notification.MeetupPublished.Meetup.ShouldBe(fact.Card);
        notification.MeetupPublished.Meetup.Title.ShouldBe("Пятничная");
    }

    /// <summary>
    /// Готового текста и chat_id в контракте нет по построению; проверяется
    /// то, что сервис мог бы положить сам: срок годности и чужой request_id.
    /// </summary>
    [Fact]
    public void MeetupPublished_NoRequestId_LeavesOptionalFieldsUnset()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2));

        var notification = NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now);

        notification.HasNotAfter.ShouldBeFalse();
        notification.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void MeetupPublished_EventRequestId_CarriedUnchanged()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, requestId: "req-7"));

        NotificationFacts.MeetupPublished(NotificationId, RecipientId, fact, Now).RequestId.ShouldBe("req-7");
    }

    [Fact]
    public void MeetupPublished_NotFirstPublication_Throws()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3);
        message.MeetupRepublished = new Meetups.V1.MeetupRepublished();

        Should.Throw<ArgumentException>(() =>
            NotificationFacts.MeetupPublished(NotificationId, RecipientId, Decode(message), Now));
    }

    /// <summary>
    /// Карточка в факте — копия, а не ссылка: один повод разворачивается на
    /// многих получателей, и правка одного сообщения не должна задевать другие.
    /// </summary>
    [Fact]
    public void MeetupPublished_TwoRecipients_ShareNoCardInstance()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2));

        var first = NotificationFacts.MeetupPublished(Guid.CreateVersion7(), RecipientId, fact, Now);
        var second = NotificationFacts.MeetupPublished(Guid.CreateVersion7(), Guid.CreateVersion7(), fact, Now);

        ReferenceEquals(first.MeetupPublished.Meetup, second.MeetupPublished.Meetup).ShouldBeFalse();
    }

    [Fact]
    public void MeetupChanged_Aspects_CarriedWithCurrentCard()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3, title: "Перенесённая", requestId: "req-9");
        message.MeetupChanged = new Meetups.V1.MeetupChanged();
        var fact = Decode(message);

        var notification = NotificationFacts.MeetupChanged(
            NotificationId, RecipientId, fact, [MeetupAspect.Title, MeetupAspect.Schedule], Now);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupChanged);
        notification.MeetupChanged.Meetup.Title.ShouldBe("Перенесённая");
        notification.MeetupChanged.ChangedAspects.ShouldBe([MeetupAspect.Title, MeetupAspect.Schedule]);
        notification.Cause.MeetupEventId.ShouldBe(fact.EventId.ToString());
        notification.RequestId.ShouldBe("req-9");
        notification.HasNotAfter.ShouldBeFalse();
    }

    [Fact]
    public void MeetupChanged_EmptyChange_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() =>
            NotificationFacts.MeetupChanged(NotificationId, RecipientId, fact, [], Now));
    }

    [Fact]
    public void MeetupMaterial_AttachedMaterial_CarriesIdAndTitle()
    {
        var materialId = EventFactory.NewId();
        var fact = Decode(EventFactory.Material(EventFactory.NewId(), version: 3, materialId, "Фото"));

        var notification = NotificationFacts.MeetupMaterial(NotificationId, RecipientId, fact, Now);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupMaterial);
        notification.MeetupMaterial.MaterialId.ShouldBe(materialId);
        notification.MeetupMaterial.MaterialTitle.ShouldBe("Фото");
        notification.MeetupMaterial.Meetup.ShouldBe(fact.Card);
    }

    [Fact]
    public void MeetupMaterial_NotMaterialOccasion_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() => NotificationFacts.MeetupMaterial(NotificationId, RecipientId, fact, Now));
    }

    [Fact]
    public void MeetupUnpublished_Unpublication_CarriesCard()
    {
        var message = EventFactory.Meetup(EventFactory.NewId(), version: 3);
        message.State.Visibility = Meetups.V1.MeetupVisibility.Hidden;
        message.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();
        var fact = Decode(message);

        var notification = NotificationFacts.MeetupUnpublished(NotificationId, RecipientId, fact, Now);

        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.MeetupUnpublished);
        notification.MeetupUnpublished.Meetup.ShouldBe(fact.Card);
    }

    [Fact]
    public void MeetupUnpublished_NotUnpublication_Throws()
    {
        var fact = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 3));

        Should.Throw<ArgumentException>(() => NotificationFacts.MeetupUnpublished(NotificationId, RecipientId, fact, Now));
    }

    [Fact]
    public void MeetupPublishedByDefault_NoPreferenceRow_IsEnabled() =>
        NotificationFacts.MeetupPublishedByDefault.ShouldBeTrue();

    [Fact]
    public void HubCircle_PublicRole_IsOutside() =>
        NotificationFacts.HubCircle.ShouldBe(["admin", "maintainer", "member"], ignoreOrder: true);

    private static MeetupFact Decode(Meetups.V1.MeetupEvent message) =>
        ReplicaMapping.Meetup(EventFactory.Bytes(message))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<MeetupFact>();
}
