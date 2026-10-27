using Grpc.Core;
using Notifications.Auction;
using Notifications.Broadcasts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Фильтр аудитории объявления аукциона (PER-778) от команды до строки outbox:
/// Auction подставлен и отвечает, кто в розыгрыше и с прогнозом; предпросмотр
/// и команда считают аудиторию одним путём.
/// </summary>
public class AuctionNoticeAudienceTests
{
    private static string NewId() => Guid.CreateVersion7().ToString();

    private static CallOptions Plain => new(cancellationToken: TestContext.Current.CancellationToken);

    private static BroadcastAuctionNoticeRequest Notice(
        Guid author,
        string meetupId,
        string id,
        AuctionNoticeAudience audience) =>
        new()
        {
            IdentityId = author.ToString(),
            MeetupId = meetupId,
            Id = id,
            Body = "Успей в розыгрыш",
            Button = new AuctionNoticeButton { View = AuctionNoticeView.Raffle },
            Audience = audience,
        };

    private static PreviewAuctionNoticeRequest Preview(Guid author, string meetupId, AuctionNoticeAudience audience) =>
        new() { IdentityId = author.ToString(), MeetupId = meetupId, Audience = audience };

    private sealed record Crowd(Guid Author, Guid Registered, Guid Forecaster, Guid Both, Guid Neither);

    // Автор не вовлечён: он держатель права ставок и адресат, как все.
    private static async Task<Crowd> Gather(BroadcastsUnderTest env, bool raffleOpen = true, bool roundOpen = true)
    {
        var crowd = new Crowd(
            await Person(env.Db, AdminHolding),
            await Person(env.Db, MemberHolding),
            await Person(env.Db, GuestHolding),
            await Person(env.Db, MemberHolding),
            await Person(env.Db, GuestHolding));
        env.Auction.Answer = new EngagementRead.Known(
            raffleOpen,
            raffleOpen ? new HashSet<Guid> { crowd.Registered, crowd.Both } : new HashSet<Guid>(),
            roundOpen,
            roundOpen ? new HashSet<Guid> { crowd.Forecaster, crowd.Both } : new HashSet<Guid>());

        return crowd;
    }

    public static TheoryData<AuctionNoticeAudience> Narrowing() =>
    [
        AuctionNoticeAudience.NotInRaffle,
        AuctionNoticeAudience.WithoutPredictions,
        AuctionNoticeAudience.NotInRaffleOrWithoutPredictions,
    ];

    private static Guid[] Expected(Crowd crowd, AuctionNoticeAudience audience) => audience switch
    {
        AuctionNoticeAudience.NotInRaffle => [crowd.Author, crowd.Forecaster, crowd.Neither],
        AuctionNoticeAudience.WithoutPredictions => [crowd.Author, crowd.Registered, crowd.Neither],
        AuctionNoticeAudience.NotInRaffleOrWithoutPredictions =>
            [crowd.Author, crowd.Registered, crowd.Forecaster, crowd.Neither],
        _ => [crowd.Author, crowd.Registered, crowd.Forecaster, crowd.Both, crowd.Neither],
    };

    /// <summary>
    /// Каждый фильтр отдаёт факт ровно тем, кого не исключил, и предпросмотр
    /// называет то же число; Auction спрошен об аукционе этой сходки.
    /// </summary>
    [Theory]
    [MemberData(nameof(Narrowing))]
    public async Task When_AudienceNarrowed_Expect_FactsForTheNotEngagedAndPreviewOfSameCount(AuctionNoticeAudience audience)
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var crowd = await Gather(env);
        var id = NewId();

        var preview = await env.Client.PreviewAuctionNoticeAsync(Preview(crowd.Author, meetupId, audience), Plain);
        var accepted = await env.Client.BroadcastAuctionNoticeAsync(Notice(crowd.Author, meetupId, id, audience), Plain);

        accepted.Created.ShouldBeTrue();
        var facts = await env.Facts(id);
        facts.Select(fact => fact.RecipientId).ShouldBe(Expected(crowd, audience), ignoreOrder: true);
        preview.RecipientCount.ShouldBe(facts.Count);
        env.Auction.Asked.ShouldAllBe(auction => auction == AuctionOfMeetup.Of(Guid.Parse(meetupId)));
        env.Auction.Asked.Count.ShouldBe(2);
    }

    /// <summary>«Все» — по-прежнему все держатели, и Auction не спрошен.</summary>
    [Theory]
    [InlineData(AuctionNoticeAudience.Unspecified)]
    [InlineData(AuctionNoticeAudience.All)]
    public async Task When_AudienceAll_Expect_EveryHolderWithoutAskingAuction(AuctionNoticeAudience audience)
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var crowd = await Gather(env);
        var id = NewId();

        var preview = await env.Client.PreviewAuctionNoticeAsync(Preview(crowd.Author, meetupId, audience), Plain);
        await env.Client.BroadcastAuctionNoticeAsync(Notice(crowd.Author, meetupId, id, audience), Plain);

        var facts = await env.Facts(id);
        facts.Select(fact => fact.RecipientId).ShouldBe(Expected(crowd, AuctionNoticeAudience.All), ignoreOrder: true);
        preview.RecipientCount.ShouldBe(facts.Count);
        env.Auction.Asked.ShouldBeEmpty();
    }

    /// <summary>
    /// После закрытия регистрации (T) «не в розыгрыше» и его сумма с прогнозами
    /// отказывают FAILED_PRECONDITION без ключа и фактов, а «без прогнозов»
    /// работает.
    /// </summary>
    [Fact]
    public async Task When_RegistrationClosed_Expect_RaffleFiltersRefusedAndPredictionsFilterWorks()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var crowd = await Gather(env, raffleOpen: false);
        var refusedId = NewId();
        var unionId = NewId();
        var id = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(crowd.Author, meetupId, refusedId, AuctionNoticeAudience.NotInRaffle), Plain).ResponseAsync);
        var union = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(crowd.Author, meetupId, unionId, AuctionNoticeAudience.NotInRaffleOrWithoutPredictions),
                Plain).ResponseAsync);
        var previewRefused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.PreviewAuctionNoticeAsync(
                Preview(crowd.Author, meetupId, AuctionNoticeAudience.NotInRaffle), Plain).ResponseAsync);
        var accepted = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.WithoutPredictions), Plain);

        refused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        union.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        previewRefused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
        (await env.Facts(refusedId)).ShouldBeEmpty();
        (await env.Facts(unionId)).ShouldBeEmpty();
        accepted.Created.ShouldBeTrue();
        (await env.Facts(id)).Select(fact => fact.RecipientId)
            .ShouldBe([crowd.Author, crowd.Registered, crowd.Neither], ignoreOrder: true);
        (await env.Accepted()).ShouldBe(1);
    }

    /// <summary>
    /// Auction молчит — UNAVAILABLE, ключ не принят, фактов нет: отката на
    /// «всем» нет. Объявление «всем» при этом уходит.
    /// </summary>
    [Fact]
    public async Task When_AuctionSilent_Expect_UnavailableAndNoFacts()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var crowd = await Gather(env);
        env.Auction.Answer = new EngagementRead.Unavailable("auction DeadlineExceeded");
        var id = NewId();
        var everyoneId = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.WithoutPredictions), Plain).ResponseAsync);
        var previewRefused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.PreviewAuctionNoticeAsync(
                Preview(crowd.Author, meetupId, AuctionNoticeAudience.WithoutPredictions), Plain).ResponseAsync);
        await env.Client.BroadcastAuctionNoticeAsync(
            Notice(crowd.Author, meetupId, everyoneId, AuctionNoticeAudience.All), Plain);

        refused.StatusCode.ShouldBe(StatusCode.Unavailable);
        previewRefused.StatusCode.ShouldBe(StatusCode.Unavailable);
        (await env.Facts(id)).ShouldBeEmpty();
        (await env.Facts(everyoneId)).Count.ShouldBe(5);
        (await env.Accepted()).ShouldBe(1);
    }

    /// <summary>
    /// Без адреса Auction фильтр отказывает UNAVAILABLE, а «всем» работает —
    /// composition root как есть, без подстановки Auction.
    /// </summary>
    [Fact]
    public async Task When_AuctionNotConfigured_Expect_FilterUnavailableAndAllWorks()
    {
        await using var env = await BroadcastsUnderTest.StartWithoutAuction();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, AdminHolding);
        var id = NewId();
        var everyoneId = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(author, meetupId, id, AuctionNoticeAudience.NotInRaffle), Plain).ResponseAsync);
        var accepted = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(author, meetupId, everyoneId, AuctionNoticeAudience.All), Plain);

        refused.StatusCode.ShouldBe(StatusCode.Unavailable);
        accepted.Created.ShouldBeTrue();
        (await env.Facts(id)).ShouldBeEmpty();
    }

    /// <summary>
    /// Повтор принятого объявления с фильтром — повтор, даже когда Auction уже
    /// молчит; тот же ключ с другим фильтром — конфликт.
    /// </summary>
    [Fact]
    public async Task When_NarrowedNoticeRepeated_Expect_RepeatWithoutAuctionAndConflictOnOtherAudience()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var crowd = await Gather(env);
        var id = NewId();

        var first = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.NotInRaffle), Plain);
        env.Auction.Answer = new EngagementRead.Unavailable("auction Unavailable");
        var repeated = await env.Client.BroadcastAuctionNoticeAsync(
            Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.NotInRaffle), Plain);
        var otherAudience = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.WithoutPredictions), Plain).ResponseAsync);
        var asAll = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastAuctionNoticeAsync(
                Notice(crowd.Author, meetupId, id, AuctionNoticeAudience.All), Plain).ResponseAsync);

        repeated.Created.ShouldBeFalse();
        repeated.AcceptedAt.ShouldBe(first.AcceptedAt);
        otherAudience.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        asAll.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        (await env.Facts(id)).Count.ShouldBe(3);
        env.Auction.Asked.Count.ShouldBe(1);
    }
}
