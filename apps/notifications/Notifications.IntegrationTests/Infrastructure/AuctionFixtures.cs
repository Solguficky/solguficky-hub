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

    public static Task<long> Count(IsolatedDatabase db, string table) =>
        Scalar<long>(db, $"SELECT count(*) FROM {table};");

    public static async Task<Notification> StoredFact(IsolatedDatabase db) =>
        Notification.Parser.ParseFrom(await Scalar<byte[]>(db, "SELECT payload FROM notification;"));

    public static Task RejectOutbox(IsolatedDatabase db) => Execute(db, """
        CREATE FUNCTION reject_auction_fact() RETURNS trigger LANGUAGE plpgsql AS $func$
        BEGIN RAISE EXCEPTION 'outbox unavailable'; END; $func$;
        CREATE TRIGGER reject_auction_fact BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION reject_auction_fact();
        """);

    public static Task RestoreOutbox(IsolatedDatabase db) => Execute(db, "DROP TRIGGER reject_auction_fact ON notification;");

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
