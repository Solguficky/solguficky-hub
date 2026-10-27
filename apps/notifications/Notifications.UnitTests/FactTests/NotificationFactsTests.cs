using Notifications.Facts;
using Notifications.Infrastructure;
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
    public void HubRight_IsTheRightOfTheHub() =>
        NotificationFacts.HubRight.ShouldBe("access_hub");

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

    /// <summary>
    /// Повод ручной рассылки — команда: ссылка на её id, отправитель
    /// внутренним идентификатором, авторский текст дословно и цепочка команды.
    /// </summary>
    [Fact]
    public void OrganizerMessage_AcceptedBroadcast_ReferencesCommandAndCarriesCardAndBody()
    {
        var broadcastId = Guid.CreateVersion7();
        var senderId = Guid.CreateVersion7();
        var card = Decode(EventFactory.Meetup(EventFactory.NewId(), version: 2, title: "Пятничная")).Card;

        var notification = NotificationFacts.OrganizerMessage(
            NotificationId, RecipientId, broadcastId, senderId, card, " Текст как есть ", "req-1", Now, NotAfter);

        notification.Cause.CommandRequestId.ShouldBe(broadcastId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.OrganizerMessage);
        notification.OrganizerMessage.Meetup.ShouldBe(card);
        notification.OrganizerMessage.SenderId.ShouldBe(senderId.ToString());
        notification.OrganizerMessage.Body.ShouldBe(" Текст как есть ");
        notification.RequestId.ShouldBe("req-1");
        notification.NotAfter.ShouldBe("2026-09-26T10:15:30Z");
    }

    [Fact]
    public void CommunityAnnouncement_WithoutChain_CarriesNoMeetupAndNoRequestId()
    {
        var broadcastId = Guid.CreateVersion7();
        var senderId = Guid.CreateVersion7();

        var notification = NotificationFacts.CommunityAnnouncement(
            NotificationId, RecipientId, broadcastId, senderId, "Общий сбор", requestId: null, Now, NotAfter);

        notification.Cause.CommandRequestId.ShouldBe(broadcastId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.CommunityAnnouncement);
        notification.CommunityAnnouncement.SenderId.ShouldBe(senderId.ToString());
        notification.CommunityAnnouncement.Body.ShouldBe("Общий сбор");
        notification.HasRequestId.ShouldBeFalse();
    }

    /// <summary>
    /// Объявление аукциона: повод — команда, аукцион выведен из сходки правилом
    /// Auction, кнопка и фото — ссылками, как их принял сервис.
    /// </summary>
    [Fact]
    public void AuctionNotice_AcceptedBroadcast_DerivesAuctionAndCarriesButtonAndPhoto()
    {
        var broadcastId = Guid.CreateVersion7();
        var senderId = Guid.CreateVersion7();
        var meetupId = Guid.Parse("0190a0e0-0000-7000-8000-000000000001");
        var lotId = Guid.CreateVersion7();
        var photoId = Guid.CreateVersion7();
        var content = new AuctionNoticeContent(new NoticeButton("lot", lotId), new NoticePhoto.LotPhoto(lotId, photoId));

        var notification = NotificationFacts.AuctionNotice(
            NotificationId, RecipientId, broadcastId, senderId, meetupId, "Пятничная", "Последний час!", content,
            "req-1", Now, NotAfter);

        notification.Cause.CommandRequestId.ShouldBe(broadcastId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionNotice);
        notification.AuctionNotice.AuctionId.ShouldBe("daef05c7-cd68-5048-b03d-cb4860e8dc73");
        notification.AuctionNotice.MeetupId.ShouldBe(meetupId.ToString());
        notification.AuctionNotice.MeetupTitle.ShouldBe("Пятничная");
        notification.AuctionNotice.SenderId.ShouldBe(senderId.ToString());
        notification.AuctionNotice.Body.ShouldBe("Последний час!");
        notification.AuctionNotice.Button.View.ShouldBe(AuctionNoticeView.Lot);
        notification.AuctionNotice.Button.LotId.ShouldBe(lotId.ToString());
        notification.AuctionNotice.Photo.LotPhoto.LotId.ShouldBe(lotId.ToString());
        notification.AuctionNotice.Photo.LotPhoto.PhotoId.ShouldBe(photoId.ToString());
        notification.RequestId.ShouldBe("req-1");
    }

    [Fact]
    public void AuctionNotice_ChannelPost_CarriesMessageIdOnly()
    {
        var notification = NotificationFacts.AuctionNotice(
            NotificationId, RecipientId, Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), "",
            "Розыгрыш!", new AuctionNoticeContent(new NoticeButton("raffle", null), new NoticePhoto.ChannelPost(42)),
            requestId: null, Now, NotAfter);

        notification.AuctionNotice.Photo.SourceCase.ShouldBe(AuctionNoticePhoto.SourceOneofCase.ChannelPost);
        notification.AuctionNotice.Photo.ChannelPost.MessageId.ShouldBe(42);
    }

    [Fact]
    public void AuctionNotice_WithoutButton_LeavesButtonAbsent()
    {
        var notification = NotificationFacts.AuctionNotice(
            NotificationId, RecipientId, Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), "",
            "Спасибо всем!", new AuctionNoticeContent(null, null), requestId: null, Now, NotAfter);

        notification.AuctionNotice.Button.ShouldBeNull();
        notification.AuctionNotice.Body.ShouldBe("Спасибо всем!");
    }

    [Fact]
    public void AuctionNotice_WithoutPhoto_LeavesPhotoAbsentAndLotEmpty()
    {
        var notification = NotificationFacts.AuctionNotice(
            NotificationId, RecipientId, Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), "",
            "Торги открыты", new AuctionNoticeContent(new NoticeButton("lots", null), null), requestId: null, Now, NotAfter);

        notification.AuctionNotice.Button.View.ShouldBe(AuctionNoticeView.Lots);
        notification.AuctionNotice.Button.LotId.ShouldBeEmpty();
        notification.AuctionNotice.Photo.ShouldBeNull();
        notification.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void AccessRequested_Application_CarriesQueueAndIdentityEventButNotTheApplicant()
    {
        var applicant = EventFactory.NewId();
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Application(applicant, version: 2, Identity.V1.Circle.Guest)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        var notification = NotificationFacts.AccessRequested(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.RecipientId.ShouldBe(RecipientId.ToString());
        notification.Cause.IdentityEventId.ShouldBe(fact.EventId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.AccessRequested);
        notification.AccessRequested.Queue.ShouldBe(Identity.V1.ApplicationQueue.Auction);
        notification.NotAfter.ShouldBe(NotificationFacts.Instant(NotAfter));
        notification.HasRequestId.ShouldBeFalse();
        // Кто просит — данные модератора: заявителя нет нигде в сообщении.
        notification.ToString().ShouldNotContain(applicant);
    }

    [Fact]
    public void AccessRequested_Application_CarriesTheApplicationCursor()
    {
        var message = EventFactory.Application(EventFactory.NewId(), version: 2, Identity.V1.Circle.Member);
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(message))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        var notification = NotificationFacts.AccessRequested(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.AccessRequested.ApplicationId.ShouldBe(message.ApplicationSubmitted.ApplicationId);
        notification.AccessRequested.CreatedAt.ShouldBe(message.ApplicationSubmitted.CreatedAt);
    }

    [Fact]
    public void AccessRequested_ApplicationWithoutCursor_LeavesItEmpty()
    {
        var message = EventFactory.Application(EventFactory.NewId(), version: 2, Identity.V1.Circle.Member);
        message.ApplicationSubmitted.ApplicationId = string.Empty;
        message.ApplicationSubmitted.CreatedAt = string.Empty;
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(message))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        var notification = NotificationFacts.AccessRequested(NotificationId, RecipientId, fact, Now, NotAfter);

        notification.AccessRequested.ApplicationId.ShouldBeEmpty();
        notification.AccessRequested.CreatedAt.ShouldBeEmpty();
    }

    [Fact]
    public void AccessRequested_OtherOccasion_Throws()
    {
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Identity(EventFactory.NewId(), version: 2)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        Should.Throw<ArgumentException>(() => NotificationFacts.AccessRequested(NotificationId, RecipientId, fact, Now, NotAfter));
    }

    [Fact]
    public void AccessGranted_Admission_AddressesTheApplicantWithQueue()
    {
        var applicant = EventFactory.NewId();
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Admission(applicant, version: 4, Identity.V1.Circle.Guest)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        var notification = NotificationFacts.AccessGranted(NotificationId, fact, Now, NotAfter);

        notification.RecipientId.ShouldBe(applicant);
        notification.Cause.IdentityEventId.ShouldBe(fact.EventId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.AccessGranted);
        notification.AccessGranted.Queue.ShouldBe(Identity.V1.ApplicationQueue.Auction);
        notification.NotAfter.ShouldBe(NotificationFacts.Instant(NotAfter));
        notification.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void AccessGranted_OtherOccasion_Throws()
    {
        // Смена круга допуском по заявке не является: её даёт и белый список.
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Identity(EventFactory.NewId(), version: 2)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        Should.Throw<ArgumentException>(() => NotificationFacts.AccessGranted(NotificationId, fact, Now, NotAfter));
    }

    [Fact]
    public void PresetGranted_AdminGrant_AddressesThePersonWithPreset()
    {
        var person = EventFactory.NewId();
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.PresetGrant(person, version: 3, Identity.V1.Preset.Admin)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        var notification = NotificationFacts.PresetGranted(NotificationId, fact, Now, NotAfter);

        notification.NotificationId.ShouldBe(NotificationId.ToString());
        notification.RecipientId.ShouldBe(person);
        notification.CreatedAt.ShouldBe("2026-09-25T10:15:30Z");
        notification.Cause.IdentityEventId.ShouldBe(fact.EventId.ToString());
        notification.TypeCase.ShouldBe(Notification.TypeOneofCase.PresetGranted);
        notification.PresetGranted.Preset.ShouldBe(Identity.V1.Preset.Admin);
        notification.NotAfter.ShouldBe(NotificationFacts.Instant(NotAfter));
        notification.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void PresetGranted_MaintainerGrant_Throws()
    {
        // Набор maintainer выдаёт только общий секрет: о нём не пишут.
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.PresetGrant(EventFactory.NewId(), version: 3, Identity.V1.Preset.Maintainer)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        Should.Throw<ArgumentException>(() => NotificationFacts.PresetGranted(NotificationId, fact, Now, NotAfter));
    }

    [Theory]
    [InlineData(Identity.V1.Circle.Member)]
    [InlineData(Identity.V1.Circle.Guest)]
    public void PresetGranted_CircleChange_Throws(Identity.V1.Circle circle)
    {
        // Смену круга дают и белый список, и допуск: о ней пишет не этот факт.
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.CircleChange(EventFactory.NewId(), version: 3, circle)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        Should.Throw<ArgumentException>(() => NotificationFacts.PresetGranted(NotificationId, fact, Now, NotAfter));
    }

    [Fact]
    public void PresetGranted_OtherOccasion_Throws()
    {
        var fact = ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Admission(EventFactory.NewId(), version: 4, Identity.V1.Circle.Member)))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<IdentityFact>();

        Should.Throw<ArgumentException>(() => NotificationFacts.PresetGranted(NotificationId, fact, Now, NotAfter));
    }

    private static MeetupFact Decode(Meetups.V1.MeetupEvent message) =>
        ReplicaMapping.Meetup(EventFactory.Bytes(message))
            .ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<MeetupFact>();
}
