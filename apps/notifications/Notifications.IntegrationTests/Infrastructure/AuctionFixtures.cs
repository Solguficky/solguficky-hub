using Dapper;
using Microsoft.Extensions.Options;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>Механика базы и входного события для сценариев аукционных поводов.</summary>
public static class AuctionFixtures
{
    public static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public static IsolatedDatabase Database()
    {
        var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        return db;
    }

    public static AuctionStore Store(NpgsqlDataSource source) => new(source, Options.Create(new FactOptions()));

    public static AuctionBid Decode(global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.BidPlacedSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Bid>().Value;

    public static AuctionSale DecodeSale(global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.LotSoldSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Sale>().Value;

    public static AuctionRemoval DecodeRemoval(global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.ParticipantRemovedSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Removal>().Value;

    /// <summary>Факт лота без повода: удержание, открытие и прочее.</summary>
    public static AuctionLotFact DecodeLot(string subject, global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode(subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Lot>().Value;

    /// <summary>Лидер и цена из реплики лота: по нему адресуются напоминание и «перебили».</summary>
    public static async Task<Guid?> ReplicaLeader(IsolatedDatabase db, string lotId)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(
            "SELECT leader_id FROM lot_replica WHERE lot_id = @LotId;",
            new { LotId = Guid.Parse(lotId) }, cancellationToken: Cancellation));
    }

    /// <summary>Удержание лота: его читают анонс состава финала и весть «твой лот следующий».</summary>
    public static async Task<(Guid? Leader, long Price)?> Hold(IsolatedDatabase db, string lotId)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        var row = await connection.QuerySingleOrDefaultAsync<(Guid? Leader, long Price)?>(new CommandDefinition(
            "SELECT leader_id AS \"Leader\", price_minor_units AS \"Price\" FROM lot_hold WHERE lot_id = @LotId;",
            new { LotId = Guid.Parse(lotId) }, cancellationToken: Cancellation));
        return row;
    }    public static Task<long> Count(IsolatedDatabase db, string table) =>
        Scalar<long>(db, $"SELECT count(*) FROM {table};");

    public static async Task<Notification> StoredFact(IsolatedDatabase db) =>
        Notification.Parser.ParseFrom(await Scalar<byte[]>(db, "SELECT payload FROM notification;"));

    public static Task RejectOutbox(IsolatedDatabase db) => Execute(db, """
        CREATE FUNCTION reject_auction_fact() RETURNS trigger LANGUAGE plpgsql AS $func$
        BEGIN RAISE EXCEPTION 'outbox unavailable'; END; $func$;
        CREATE TRIGGER reject_auction_fact BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION reject_auction_fact();
        """);

    public static Task RestoreOutbox(IsolatedDatabase db) => Execute(db, "DROP TRIGGER reject_auction_fact ON notification;");

    /// <summary>Ставка с заданной ценой: окно частоты запоминает цену последнего перебития.</summary>
    public static global::Auction.V1.LotEvent PricedBid(string lotId, string previousLeader, string leader, long version,
        long minorUnits)
    {
        var message = EventFactory.Bid(lotId, previousLeader, leader, version);
        message.State.Trading.CurrentPrice.MinorUnits = minorUnits;
        return message;
    }

    /// <summary>Настройка перебитий участника, как её записала бы команда.</summary>
    public static async Task SetOutbid(IsolatedDatabase db, string identityId, OutbidFrequency frequency)
    {
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        await using var work = await UnitOfWork.Begin(source, Cancellation);
        await OutbidStore.SetPreference(work, Guid.Parse(identityId), frequency, EventFactory.Committed, Cancellation);
        await work.Commit(Cancellation);
    }

    /// <summary>Выключатель анонса финала участника, как его записала бы команда.</summary>
    public static async Task SetFinalAnnouncements(IsolatedDatabase db, string identityId, bool enabled)
    {
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        await using var work = await UnitOfWork.Begin(source, Cancellation);
        await FinalStore.SetAnnouncements(work, Guid.Parse(identityId), enabled, EventFactory.Committed, Cancellation);
        await work.Commit(Cancellation);
    }

    /// <summary>Выключатель перебитий в живом финале участника, как его записала бы команда.</summary>
    public static async Task SetLiveFinalOutbids(IsolatedDatabase db, string identityId, bool enabled)
    {
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        await using var work = await UnitOfWork.Begin(source, Cancellation);
        await OutbidStore.SetLiveFinal(work, Guid.Parse(identityId), enabled, EventFactory.Committed, Cancellation);
        await work.Commit(Cancellation);
    }

    /// <summary>Выключатель вестей о новом аукционе, как его записала бы команда (PER-646).</summary>
    public static async Task SetAuctionAnnouncements(IsolatedDatabase db, string identityId, bool enabled)
    {
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        await using var work = await UnitOfWork.Begin(source, Cancellation);
        await AuctionAnnouncementStore.Set(work, Guid.Parse(identityId), enabled, EventFactory.Committed,
            Cancellation);
        await work.Commit(Cancellation);
    }

    /// <summary>Та же ставка, но на лоте живого финала (<c>LOT_PHASE_LIVE</c>).</summary>
    public static global::Auction.V1.LotEvent Live(global::Auction.V1.LotEvent bid)
    {
        bid.State.Trading.Phase = global::Auction.V1.LotPhase.Live;
        return bid;
    }

    /// <summary>Закрывает все окна, наступившие к моменту, как это сделал бы проход.</summary>
    public static async Task<int> CloseDueWindows(AuctionStore store, DateTimeOffset now)
    {
        var created = 0;
        foreach (var recipientId in await store.DueDigests(now, 256, Cancellation))
        {
            created += await store.CloseDigest(recipientId, now, Cancellation);
        }
        return created;
    }

    /// <summary>Сдвигает момент закрытия всех окон в прошлое: время двигается данными.</summary>
    public static Task ExpireWindows(IsolatedDatabase db) =>
        Execute(db, "UPDATE outbid_digest SET due_at = now() - interval '1 second';");

    /// <summary>Сводки в порядке записи; другие типы пропускаются.</summary>
    public static async Task<IReadOnlyList<Notification>> StoredDigests(IsolatedDatabase db) =>
        (await StoredFacts(db)).Where(fact => fact.TypeCase == Notification.TypeOneofCase.LotActivityDigest).ToArray();

    public static async Task<IReadOnlyList<Notification>> StoredFacts(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        var payloads = await connection.QueryAsync<byte[]>(
            new CommandDefinition("SELECT payload FROM notification ORDER BY created_at;", cancellationToken: Cancellation));
        return payloads.Select(payload => Notification.Parser.ParseFrom(payload)).ToArray();
    }

    public static async Task PruneEventKeys(IsolatedDatabase db, DateTimeOffset threshold)
    {
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        await new ConsumedEventStore(source).Prune(threshold, Cancellation);
    }

    private static async Task<T> Scalar<T>(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleAsync<T>(new CommandDefinition(sql, cancellationToken: Cancellation));
    }

    private static async Task Execute(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.ExecuteAsync(new CommandDefinition(sql, cancellationToken: Cancellation));
    }
}
