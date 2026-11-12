using Grpc.Core;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Объявление аукциона и положение аукциона (PER-780): скрытый, отменённый и
/// удалённый аукцион команда не объявляет, а скрытие, отмена и удаление после
/// приёма снимают неотправленные объявления. Факты аукциона идут тем же
/// разбором и хранилищем, что у потребителя шины.
/// </summary>
public class AuctionNoticeStandingTests
{
    private const string PublishedSubject = "events.auction.auction_published";
    private const string HiddenSubject = "events.auction.auction_hidden";
    private const string CancelledSubject = "events.auction.auction_cancelled";
    private const string DiscardedSubject = "events.auction.auction_discarded";
    private const string FinishedSubject = "events.auction.auction_finished";
    private const string DraftedSubject = "events.auction.auction_drafted";

    private static CallOptions Plain => new(cancellationToken: TestContext.Current.CancellationToken);

    private static BroadcastAuctionNoticeRequest Notice(Guid author, string meetupId, string id) =>
        new()
        {
            IdentityId = author.ToString(),
            MeetupId = meetupId,
            Id = id,
            Body = "Последний час торгов",
            Button = new AuctionNoticeButton { View = AuctionNoticeView.Lots },
        };

    private static PreviewAuctionNoticeRequest Preview(Guid author, string meetupId) =>
        new() { IdentityId = author.ToString(), MeetupId = meetupId };

    private static string AuctionOf(string meetupId) => AuctionOfMeetup.Of(Guid.Parse(meetupId)).ToString();

    public static TheoryData<string> ClosingSubjects => [HiddenSubject, CancelledSubject, DiscardedSubject];

    private static global::Auction.V1.AuctionEvent Closing(string subject, string auction, string meetup, long version)
    {
        var fact = subject switch
        {
            HiddenSubject => EventFactory.AuctionHidden(auction, meetup),
            CancelledSubject => EventFactory.AuctionCancelled(auction, meetup),
            DiscardedSubject => EventFactory.AuctionDiscarded(auction, meetup),
            _ => throw new ArgumentOutOfRangeException(nameof(subject)),
        };
        fact.Version = version;
        return fact;
    }

    private static string ReasonOf(string subject) => subject switch
    {
        HiddenSubject => NotificationFacts.WithdrawnOnAuctionHidden,
        CancelledSubject => NotificationFacts.WithdrawnOnAuctionCancelled,
        DiscardedSubject => NotificationFacts.WithdrawnOnAuctionDiscarded,
        _ => throw new ArgumentOutOfRangeException(nameof(subject)),
    };

    /// <summary>
    /// Аукцион скрыт, отменён или удалён — команда и предпросмотр отказывают
    /// <c>FAILED_PRECONDITION</c>, ключ не принят, фактов нет.
    /// </summary>
    [Theory]
    [MemberData(nameof(ClosingSubjects))]
    public async Task When_AuctionClosedForNotice_Expect_FailedPreconditionAndNothingAccepted(string subject)
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        await Person(env.Db, MemberHolding);
        var auction = AuctionOf(meetupId);
        await env.ApplyAuctionFact(PublishedSubject, EventFactory.AuctionPublished(auction, meetupId));
        await env.ApplyAuctionFact(subject, Closing(subject, auction, meetupId, version: 20));
        var id = EventFactory.NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain).ResponseAsync);
        var previewRefused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.PreviewAuctionNoticeAsync(Preview(author, meetupId), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        previewRefused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        (await env.Facts(id)).ShouldBeEmpty();
        (await env.Accepted()).ShouldBe(0);
    }

    /// <summary>
    /// Скрытие, отмена или удаление после приёма снимают неотправленные
    /// объявления с причиной, а вынесенное в шину не трогают.
    /// </summary>
    [Theory]
    [MemberData(nameof(ClosingSubjects))]
    public async Task When_AuctionClosedAfterNoticeAccepted_Expect_PendingWithdrawnDispatchedKept(string subject)
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var member = await Person(env.Db, MemberHolding);
        var auction = AuctionOf(meetupId);
        await env.ApplyAuctionFact(PublishedSubject, EventFactory.AuctionPublished(auction, meetupId));
        var id = EventFactory.NewId();
        await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain);
        await env.MarkDispatched(id, author);

        await env.ApplyAuctionFact(subject, Closing(subject, auction, meetupId, version: 20));

        var rows = (await env.Lifecycle(id)).ToDictionary(row => row.RecipientId);
        rows[author].DispatchedAt.ShouldNotBeNull();
        rows[author].WithdrawnAt.ShouldBeNull();
        rows[member].DispatchedAt.ShouldBeNull();
        rows[member].WithdrawnAt.ShouldNotBeNull();
        rows[member].Reason.ShouldBe(ReasonOf(subject));
    }

    /// <summary>
    /// Устаревшее скрытие — пришедшее после новой публикации с меньшей версией —
    /// аукцион не закрывает и принятых объявлений не снимает.
    /// </summary>
    [Fact]
    public async Task When_StaleHiddenArrivesAfterPublication_Expect_NoticeAcceptedAndKept()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var auction = AuctionOf(meetupId);
        var published = EventFactory.AuctionPublished(auction, meetupId);
        published.Version = 30;
        await env.ApplyAuctionFact(PublishedSubject, published);
        var id = EventFactory.NewId();
        await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, id), Plain);

        await env.ApplyAuctionFact(HiddenSubject, Closing(HiddenSubject, auction, meetupId, version: 20));

        (await env.Lifecycle(id)).ShouldAllBe(row => row.WithdrawnAt == null);
        var second = EventFactory.NewId();
        (await env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, second), Plain)).Created.ShouldBeTrue();
    }

    /// <summary>
    /// Удалённый до торгов аукцион рождается заново под тем же идентификатором:
    /// публикация нового рождения открывает объявление снова, а прошедший
    /// аукцион объявлению не закрыт — «Итоги» ведут к нему и после конца.
    /// </summary>
    [Fact]
    public async Task When_DiscardedAuctionRepublishedOrFinished_Expect_NoticeAccepted()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var auction = AuctionOf(meetupId);
        await env.ApplyAuctionFact(DiscardedSubject, Closing(DiscardedSubject, auction, meetupId, version: 5));
        var reborn = EventFactory.AuctionPublished(auction, meetupId);
        reborn.Version = 9;
        await env.ApplyAuctionFact(PublishedSubject, reborn);

        var afterRebirth = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(author, meetupId, EventFactory.NewId()), Plain);

        var finished = EventFactory.AuctionFinished(auction, meetupId);
        finished.Version = 40;
        await env.ApplyAuctionFact(FinishedSubject, finished);
        var afterFinish = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(author, meetupId, EventFactory.NewId()), Plain);

        afterRebirth.Created.ShouldBeTrue();
        afterFinish.Created.ShouldBeTrue();
    }

    /// <summary>
    /// Аукцион рождается скрытым (PER-609): до публикации команда отказывает, а
    /// публикация открывает объявление.
    /// </summary>
    [Fact]
    public async Task When_AuctionDraftedHidden_Expect_RefusedUntilPublished()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var auction = AuctionOf(meetupId);
        await env.ApplyAuctionFact(DraftedSubject, EventFactory.AuctionDrafted(auction, meetupId));

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(Notice(author, meetupId, EventFactory.NewId()), Plain).ResponseAsync);
        await env.ApplyAuctionFact(PublishedSubject, EventFactory.AuctionPublished(auction, meetupId));
        var accepted = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(author, meetupId, EventFactory.NewId()), Plain);

        refused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        accepted.Created.ShouldBeTrue();
    }
}
