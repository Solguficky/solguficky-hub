using Dapper;
using Grpc.Core;
using Notifications.Auction;
using Notifications.Favorites;
using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Избранные лоты (ADR-063): отметка по ставке и вручную, надгробие снятия,
/// реплика лота с версией и чистка по сроку — на настоящей базе; граница gRPC
/// и путь из шины — на настоящих транспорте и composition root.
/// </summary>
public class FavoriteLotTests
{
    private static readonly DateTimeOffset Now = EventFactory.Committed.AddHours(1);

    [Fact]
    public async Task When_BidRedeliveredAndLeaderBidsAgain_Expect_OneMarkForLeader()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();
        var bid = EventFactory.Bid(lot, leader: leader, version: 3);

        await store.Apply(Decode(bid), Now, Cancellation);
        await store.Apply(Decode(bid), Now, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, EventFactory.NewId(), leader, version: 5, proxy: true)), Now, Cancellation);

        (await Count(db, "lot_favorite")).ShouldBe(1);
        (await Favorites(source).List(Guid.Parse(leader), Cancellation)).ShouldBe([Guid.Parse(lot)]);
    }

    [Fact]
    public async Task When_FollowedTwice_Expect_OneRowAndFollowing()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var lot = await KnownLot(source);
        var person = Guid.CreateVersion7();
        var favorites = Favorites(source);

        await favorites.Follow(person, lot, Cancellation);
        var repeated = await favorites.Follow(person, lot, Cancellation);

        repeated.ShouldBe(new FollowResult.Done(true));
        (await Count(db, "lot_favorite")).ShouldBe(1);
    }

    /// <summary>
    /// Снятие помнится: ни следующая ручная ставка, ни ответ прокси-лимита, ни
    /// повтор старого <c>bid_placed</c>, ключ которого уже вычищен, отметку не
    /// возвращают. Вернуть её может только сам человек.
    /// </summary>
    [Fact]
    public async Task When_Unfollowed_Expect_NeitherBidNorProxyNorOldRedeliveryReturnsMark()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var favorites = Favorites(source);
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();
        var rival = EventFactory.NewId();
        var first = EventFactory.Bid(lot, leader: leader, version: 3);
        await store.Apply(Decode(first), Now, Cancellation);

        (await favorites.Unfollow(Guid.Parse(leader), Guid.Parse(lot), Cancellation)).ShouldBeFalse();
        await store.Apply(Decode(EventFactory.Bid(lot, rival, leader, version: 5)), Now, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, rival, leader, version: 7, proxy: true, answers: true)), Now,
            Cancellation);
        await PruneEventKeys(db, DateTimeOffset.UtcNow.AddDays(1));
        await store.Apply(Decode(first), Now, Cancellation);

        (await favorites.List(Guid.Parse(leader), Cancellation)).ShouldBeEmpty();
        (await Count(db, "lot_favorite")).ShouldBe(1);

        (await favorites.Follow(Guid.Parse(leader), Guid.Parse(lot), Cancellation)).ShouldBe(new FollowResult.Done(true));
        (await favorites.List(Guid.Parse(leader), Cancellation)).ShouldBe([Guid.Parse(lot)]);
    }

    [Fact]
    public async Task When_OlderFactArrivesAfterNewer_Expect_ReplicaKeepsExtendedDeadline()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();

        await store.Apply(LotFact("deadline_extended",
            EventFactory.Trading(lot, "deadline_extended", version: 5, deadline: EventFactory.Deadline(120))), Now, Cancellation);
        await store.Apply(LotFact("lot_opened",
            EventFactory.Trading(lot, "lot_opened", version: 2, deadline: EventFactory.Deadline(60))), Now, Cancellation);

        var replica = (await Replica(source, lot)).ShouldNotBeNull();
        replica.Version.ShouldBe(5);
        replica.Deadline.ShouldBe(EventFactory.Committed.AddMinutes(120));
    }

    [Fact]
    public async Task When_LotSoldAfterHold_Expect_TerminalMomentOfFirstTerminalSnapshot()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var winner = EventFactory.NewId();

        await store.Apply(LotFact("lot_held_for_final", EventFactory.HeldForFinal(lot, version: 6)), Now, Cancellation);
        (await Replica(source, lot)).ShouldNotBeNull().TerminalAt.ShouldBeNull();
        await store.Apply(DecodeSale(EventFactory.Sold(lot, winner, version: 8)), Now, Cancellation);

        var replica = (await Replica(source, lot)).ShouldNotBeNull();
        replica.Status.ShouldBe(LotStatus.Sold);
        replica.Leader.ShouldBe(Guid.Parse(winner));
        replica.TerminalAt.ShouldBe(EventFactory.Committed.AddMinutes(8));
    }

    [Fact]
    public async Task When_LotUnknownToReplica_Expect_NoMark()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);

        var result = await Favorites(source).Follow(Guid.CreateVersion7(), Guid.CreateVersion7(), Cancellation);

        result.ShouldBeOfType<FollowResult.UnknownLot>();
        (await Count(db, "lot_favorite")).ShouldBe(0);
    }

    /// <summary>
    /// Отметки и реплика лота, пришедшего в конечное положение раньше
    /// горизонта, удаляются, в том числе снятые; свежий конечный лот и лот без
    /// конечного положения живут.
    /// </summary>
    [Fact]
    public async Task When_LotClosedLongerThanRetention_Expect_ItsMarksAndReplicaPrunedAndFreshKept()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var favorites = Favorites(source);
        var person = Guid.CreateVersion7();
        var (old, fresh, open) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        foreach (var lot in new[] { old, fresh })
        {
            await store.Apply(Decode(EventFactory.Bid(lot, leader: person.ToString(), version: 3)), Now, Cancellation);
            await store.Apply(LotFact("lot_unsold", EventFactory.Unsold(lot, version: 9)), Now, Cancellation);
        }
        await store.Apply(Decode(EventFactory.Bid(open, leader: person.ToString(), version: 3)), Now, Cancellation);
        var stranger = Guid.CreateVersion7();
        await favorites.Follow(stranger, Guid.Parse(old), Cancellation);
        await favorites.Unfollow(stranger, Guid.Parse(old), Cancellation);
        await ExecuteSql(db, "UPDATE lot_replica SET terminal_at = now() - interval '31 days' WHERE lot_id = @Lot;", old);
        await ExecuteSql(db, "UPDATE lot_replica SET terminal_at = now() - interval '29 days' WHERE lot_id = @Lot;", fresh);

        var removed = await favorites.Prune(DateTimeOffset.UtcNow - TimeSpan.FromDays(30), Cancellation);

        removed.ShouldBe(1);
        (await favorites.List(person, Cancellation)).ShouldBe([Guid.Parse(fresh), Guid.Parse(open)], ignoreOrder: true);
        (await Replica(source, old)).ShouldBeNull();
        (await Count(db, "lot_favorite")).ShouldBe(2);
        (await Count(db, "lot_replica")).ShouldBe(2);
    }

    [Fact]
    public async Task When_AuctionBotFollowsAndLists_Expect_StateAnsweredOverGrpc()
    {
        await using var service = await PreferencesUnderTest.Start();
        await using var source = NpgsqlDataSource.Create(service.Database.ConnectionString);
        var lot = (await KnownLot(source)).ToString();
        var person = Guid.CreateVersion7().ToString();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);

        var followed = await client.FollowLotAsync(new FollowLotRequest { IdentityId = person, LotId = lot },
            cancellationToken: Cancellation);
        var listed = await client.ListFollowedLotsAsync(new ListFollowedLotsRequest { IdentityId = person },
            cancellationToken: Cancellation);
        var unfollowed = await client.UnfollowLotAsync(new UnfollowLotRequest { IdentityId = person, LotId = lot },
            cancellationToken: Cancellation);

        followed.ShouldBe(new LotFollowing { IdentityId = person, LotId = lot, Following = true });
        listed.LotIds.ShouldBe([lot]);
        unfollowed.Following.ShouldBeFalse();
    }

    [Fact]
    public async Task When_LotUnknownOverGrpc_Expect_FailedPrecondition()
    {
        await using var service = await PreferencesUnderTest.Start();

        var refused = await Should.ThrowAsync<RpcException>(() => service.ClientPresenting(SiloUnderTest.AuctionBotToken)
            .FollowLotAsync(new FollowLotRequest
            {
                IdentityId = Guid.CreateVersion7().ToString(), LotId = Guid.CreateVersion7().ToString(),
            }, cancellationToken: Cancellation).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.FailedPrecondition);
    }

    /// <summary>Без токена бота аукциона — UNAUTHENTICATED, в том числе с токеном бота хаба.</summary>
    [Theory]
    [InlineData(null)]
    [InlineData(SiloUnderTest.BotToken)]
    public async Task When_CallerNotAuctionBot_Expect_Unauthenticated(string? token)
    {
        await using var service = await PreferencesUnderTest.Start();

        var refused = await Should.ThrowAsync<RpcException>(() => service.ClientPresenting(token)
            .ListFollowedLotsAsync(new ListFollowedLotsRequest { IdentityId = Guid.CreateVersion7().ToString() },
                cancellationToken: Cancellation).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.Unauthenticated);
    }

    /// <summary>Путь из шины: факт лота заводит реплику, ставка — отметку лидеру.</summary>
    [Fact]
    public async Task When_LotFactsArriveOnBus_Expect_ReplicaAndLeaderMark()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();

        await nats.Publish("events.auction.lot_opened", EventFactory.Trading(lot, "lot_opened", deadline: EventFactory.Deadline(60)));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: leader, deadline: EventFactory.Deadline(60)));

        await Eventually(() => Count(db, "lot_favorite"), count => count == 1);
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("lot_replicated")), count => count == 1);
        (await Count(db, "lot_replica")).ShouldBe(1);
    }

    private static FavoriteOperations Favorites(NpgsqlDataSource source) => new(source, TimeProvider.System);

    private static AuctionLotFact LotFact(string occasion, global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode($"events.auction.{occasion}", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value;

    /// <summary>Лот, который реплика уже знает: открыт торгами.</summary>
    private static async Task<Guid> KnownLot(NpgsqlDataSource source)
    {
        var lot = EventFactory.NewId();
        await Store(source).Apply(LotFact("lot_opened", EventFactory.Trading(lot, "lot_opened")), Now, Cancellation);
        return Guid.Parse(lot);
    }

    private static async Task<LotReplica?> Replica(NpgsqlDataSource source, string lot)
    {
        await using var work = await UnitOfWork.Begin(source, Cancellation);
        return await LotReplicaStore.Read(work, Guid.Parse(lot), Cancellation);
    }

    private static async Task ExecuteSql(IsolatedDatabase db, string sql, string lot)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.ExecuteAsync(new CommandDefinition(sql, new { Lot = Guid.Parse(lot) }, cancellationToken: Cancellation));
    }
}
