using Grpc.Core;
using Notifications.Broadcasts;
using Notifications.Facts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Объявление аукциона (PER-764) от команды до строки outbox: право вести
/// аукцион спрашивается у Meetups, аудитория — держатели права ставок, как у
/// вести о новом аукционе (PER-646), с маршрутом по кругу каждого.
/// </summary>
public class AuctionNoticeTests
{
    private static readonly AuthorityAnswer Denied = new(AuthorityVerdict.Denied, "stub");
    private static readonly AuthorityAnswer Closed = new(AuthorityVerdict.Closed, "stub");

    private static string NewId() => Guid.CreateVersion7().ToString();

    private static CallOptions Plain => new(cancellationToken: TestContext.Current.CancellationToken);

    private static CallOptions Chain(string requestId) =>
        new(new Metadata { { "x-request-id", requestId } }, cancellationToken: TestContext.Current.CancellationToken);

    private static BroadcastAuctionNoticeRequest Notice(
        Guid author,
        string meetupId,
        string id,
        string body = "Последний час торгов",
        AuctionNoticeButton? button = null,
        AuctionNoticePhoto? photo = null) =>
        new()
        {
            IdentityId = author.ToString(),
            MeetupId = meetupId,
            Id = id,
            Body = body,
            Button = button ?? new AuctionNoticeButton { View = AuctionNoticeView.Lots },
            Photo = photo,
        };

    private static PreviewAuctionNoticeRequest Preview(Guid author, string meetupId) =>
        new() { IdentityId = author.ToString(), MeetupId = meetupId };

    /// <summary>
    /// По факту каждому держателю <c>place_bids</c> — участнику ботом хаба, гостю
    /// ботом аукциона; выключивший вести о новом аукционе и торгах,
    /// заблокированный и гость без права не получают. Предпросмотр называет то же
    /// число, что получила команда.
    /// </summary>
    [Fact]
    public async Task When_AuctionRunnerAnnounces_Expect_OneFactPerPlaceBidsHolderByCircle()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db, "Пятничная");
        var author = await Person(env.Db, AdminHolding);
        var member = await Person(env.Db, MemberHolding);
        var guest = await Person(env.Db, GuestHolding);
        var switchedOff = await Person(env.Db, MemberHolding);
        var blocked = await Person(env.Db, blocked: true, GuestHolding);
        var outsider = await Person(env.Db, new Holding("guest", [], []));
        await SetAuctionAnnouncements(env.Db, switchedOff.ToString(), enabled: false);
        var lotId = NewId();
        var photoId = NewId();
        var id = NewId();
        var requestId = NewId();

        var preview = await env.Client.PreviewAuctionNoticeAsync(Preview(author, meetupId), Plain);
        var accepted = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(
                author,
                meetupId,
                id,
                button: new AuctionNoticeButton { View = AuctionNoticeView.Lot, LotId = lotId },
                photo: new AuctionNoticePhoto { LotPhoto = new AuctionNoticeLotPhoto { LotId = lotId, PhotoId = photoId } }),
            Chain(requestId));

        accepted.Id.ShouldBe(id);
        accepted.Created.ShouldBeTrue();

        var facts = await env.Facts(id);
        facts.Select(fact => fact.RecipientId).ShouldBe([author, member, guest], ignoreOrder: true);
        facts.Count.ShouldBe(preview.RecipientCount);
        new[] { switchedOff, blocked, outsider }.ShouldAllBe(person => facts.All(fact => fact.RecipientId != person));
        facts.ShouldAllBe(fact => fact.Type == NotificationFacts.AuctionNoticeType);
        facts.ShouldAllBe(fact => fact.MeetupId == Guid.Parse(meetupId));
        facts.ShouldAllBe(fact => fact.RequestId == requestId);
        (await env.Surfaces(id)).ShouldBe(
            new Dictionary<Guid, string>
            {
                [author] = NotificationSubjects.Hub,
                [member] = NotificationSubjects.Hub,
                [guest] = NotificationSubjects.Auction,
            });

        var message = facts[0].Parsed();
        message.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionNotice);
        message.Cause.CommandRequestId.ShouldBe(id);
        message.AuctionNotice.MeetupId.ShouldBe(meetupId);
        message.AuctionNotice.MeetupTitle.ShouldBe("Пятничная");
        message.AuctionNotice.AuctionId.ShouldBe(Notifications.Auction.AuctionOfMeetup.Of(Guid.Parse(meetupId)).ToString());
        message.AuctionNotice.SenderId.ShouldBe(author.ToString());
        message.AuctionNotice.Body.ShouldBe("Последний час торгов");
        message.AuctionNotice.Button.View.ShouldBe(AuctionNoticeView.Lot);
        message.AuctionNotice.Button.LotId.ShouldBe(lotId);
        message.AuctionNotice.Photo.LotPhoto.PhotoId.ShouldBe(photoId);

        // Оба вызова спросили Meetups о праве вести аукцион этой сходки.
        env.Owners.Asked.Select(asked => asked.Owner).ShouldBe(["meetups:auction", "meetups:auction"]);
        env.Owners.Asked.ShouldAllBe(asked => asked.AuthorId == author && asked.MeetupId == Guid.Parse(meetupId));
    }

    /// <summary>
    /// Без права вести аукцион — отказ значением: ключ не принят, фактов нет, и
    /// предпросмотр тоже отказывает, а не называет число.
    /// </summary>
    [Fact]
    public async Task When_StrangerAnnounces_Expect_PermissionDeniedAndNothingAccepted()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Meetups = Denied;
        var meetupId = await Meetup(env.Db);
        await Person(env.Db, MemberHolding);
        var stranger = await Person(env.Db, MemberHolding);
        var id = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(Notice(stranger, meetupId, id), Plain).ResponseAsync);
        var previewRefused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.PreviewAuctionNoticeAsync(Preview(stranger, meetupId), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
        previewRefused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
        (await env.Facts(id)).ShouldBeEmpty();
        (await env.Accepted()).ShouldBe(0);
    }

    /// <summary>
    /// Повтор с тем же ключом и тем же содержимым второго факта не даёт, даже
    /// если аудитория выросла; тот же ключ с другой кнопкой или фото — конфликт.
    /// </summary>
    [Fact]
    public async Task When_NoticeRepeated_Expect_NoSecondFactAndConflictOnOtherContent()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var id = NewId();

        var first = await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain);
        var late = await Person(env.Db, GuestHolding);
        var repeated = await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain);

        repeated.Created.ShouldBeFalse();
        repeated.AcceptedAt.ShouldBe(first.AcceptedAt);
        var facts = await env.Facts(id);
        facts.ShouldHaveSingleItem().RecipientId.ShouldBe(author);
        facts.ShouldAllBe(fact => fact.RecipientId != late);

        var otherButton = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(author, meetupId, id, button: new AuctionNoticeButton { View = AuctionNoticeView.Raffle }),
                Plain).ResponseAsync);
        var otherPhoto = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(
                    author,
                    meetupId,
                    id,
                    photo: new AuctionNoticePhoto { LotPhoto = new AuctionNoticeLotPhoto { LotId = NewId(), PhotoId = NewId() } }),
                Plain).ResponseAsync);
        var otherKind = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(
                new BroadcastToMeetupSubscribersRequest
                {
                    IdentityId = author.ToString(), MeetupId = meetupId, Id = id, Body = "Последний час торгов",
                },
                Plain).ResponseAsync);

        var channelPost = new AuctionNoticePhoto { ChannelPost = new AuctionNoticeChannelPost { MessageId = 17 } };
        var postId = NewId();
        await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, postId, photo: channelPost), Plain);
        var samePost = await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, postId, photo: channelPost), Plain);
        var otherPost = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(
                    author,
                    meetupId,
                    postId,
                    photo: new AuctionNoticePhoto { ChannelPost = new AuctionNoticeChannelPost { MessageId = 18 } }),
                Plain).ResponseAsync);

        samePost.Created.ShouldBeFalse();
        otherPost.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        (await env.Facts(postId)).ShouldAllBe(fact => fact.Parsed().AuctionNotice.Photo.ChannelPost.MessageId == 17);
        otherButton.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        otherPhoto.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        otherKind.StatusCode.ShouldBe(StatusCode.AlreadyExists);
    }

    /// <summary>
    /// Реплика ещё не знает сходку: объявление уходит без названия, а не ждёт —
    /// название ему только украшение, как вести о новом аукционе.
    /// </summary>
    [Fact]
    public async Task When_MeetupNotReplicated_Expect_FactsWithoutTitle()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var author = await Person(env.Db, AdminHolding);
        var id = NewId();

        await env.Client.BroadcastAuctionNoticeAsync(Notice(author, NewId(), id), Plain);

        (await env.Facts(id)).ShouldHaveSingleItem().Parsed().AuctionNotice.MeetupTitle.ShouldBeEmpty();
    }

    /// <summary>
    /// Скрытая сходка своего названия объявлению не отдаёт: право вести аукцион
    /// видимости черновика не даёт, а объявление уходит и гостям.
    /// </summary>
    [Fact]
    public async Task When_MeetupHidden_Expect_FactsWithoutTitle()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db, "Секретная");
        await Execute(env.Db, "UPDATE meetup_replica SET visibility = 'hidden' WHERE meetup_id = @Id;",
            new { Id = Guid.Parse(meetupId) });
        var author = await Person(env.Db, AdminHolding);
        var id = NewId();

        await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain);

        (await env.Facts(id)).ShouldHaveSingleItem().Parsed().AuctionNotice.MeetupTitle.ShouldBeEmpty();
    }

    /// <summary>
    /// Кнопка необязательна: без неё объявление уходит одним текстом, а тот же
    /// ключ с кнопкой — уже другое содержимое и конфликт.
    /// </summary>
    [Fact]
    public async Task When_ButtonMissing_Expect_FactsWithoutButtonAndConflictWithButton()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        await Person(env.Db, MemberHolding);
        var id = NewId();
        var request = Notice(author, meetupId, id);
        request.Button = null;

        var accepted = await env.Client.BroadcastAuctionNoticeAsync(request, Plain);
        var withButton = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain).ResponseAsync);
        var repeated = await env.Client.BroadcastAuctionNoticeAsync(request, Plain);

        accepted.Created.ShouldBeTrue();
        repeated.Created.ShouldBeFalse();
        withButton.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        var facts = await env.Facts(id);
        facts.ShouldNotBeEmpty();
        facts.ShouldAllBe(fact => fact.Parsed().AuctionNotice.Button == null);
    }

    /// <summary>
    /// Отменённая сходка закрывает объявление её аукциона: ведущему —
    /// FAILED_PRECONDITION, ключ не принят, предпросмотр не называет числа.
    /// </summary>
    [Fact]
    public async Task When_MeetupCancelled_Expect_FailedPreconditionAndNothingAccepted()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Meetups = Closed;
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        await Person(env.Db, MemberHolding);
        var id = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain).ResponseAsync);
        var previewRefused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.PreviewAuctionNoticeAsync(Preview(author, meetupId), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        previewRefused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        (await env.Facts(id)).ShouldBeEmpty();
        (await env.Accepted()).ShouldBe(0);
    }
}
