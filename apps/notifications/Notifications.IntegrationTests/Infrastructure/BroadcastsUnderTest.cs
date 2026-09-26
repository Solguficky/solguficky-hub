using System.Collections.Concurrent;
using Dapper;
using Grpc.Net.Client;
using Microsoft.Extensions.DependencyInjection;
using Notifications.Broadcasts;
using Notifications.V1;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Владельцы права на рассылку, подставленные вместо Meetups и Identity.
/// Отвечают заданным вердиктом и запоминают, о ком и о чём их спросили.
/// </summary>
/// <remarks>
/// Сведение настоящих ответов владельцев проверяет unit-набор на
/// <see cref="OwnerAuthority" />; здесь предмет — что сервис делает с
/// вердиктом: приём ключа, разворот, статус отказа.
/// </remarks>
public sealed class StubAuthority : IBroadcastAuthority
{
    public AuthorityAnswer Meetups { get; set; } = AuthorityAnswer.Granted;

    public AuthorityAnswer Identity { get; set; } = AuthorityAnswer.Granted;

    public ConcurrentQueue<(string Owner, Guid AuthorId, Guid? MeetupId, string? RequestId)> Asked { get; } = new();

    public Task<AuthorityAnswer> MeetupBroadcast(Guid authorId, Guid meetupId, Forwarded forwarded)
    {
        Asked.Enqueue(("meetups", authorId, meetupId, forwarded.RequestId));
        return Task.FromResult(Meetups);
    }

    public Task<AuthorityAnswer> CommunityAnnouncement(Guid authorId, Forwarded forwarded)
    {
        Asked.Enqueue(("identity", authorId, null, forwarded.RequestId));
        return Task.FromResult(Identity);
    }
}

/// <summary>Строка адресного факта в том виде, в каком её прочтёт релей.</summary>
public sealed class FactRow
{
    public Guid RecipientId { get; init; }

    public string Type { get; init; } = "";

    public Guid? MeetupId { get; init; }

    public string? RequestId { get; init; }

    public byte[] Payload { get; init; } = [];

    public Notification Parsed() => Notification.Parser.ParseFrom(Payload);
}

/// <summary>
/// Сервис на изолированной базе, клиент к нему по настоящему каналу и
/// подставленные владельцы права.
/// </summary>
/// <remarks>
/// Команды идут клиентом через Kestrel и h2c, а не вызовом C#-метода: коды
/// отказов — свойство границы, как в <see cref="PreferencesUnderTest" />.
/// Шины здесь нет: факт проверяется строкой outbox, а его вынос — предмет
/// сценариев автоматических поводов, путь у них общий.
/// </remarks>
public sealed class BroadcastsUnderTest : IAsyncDisposable
{
    private readonly SiloUnderTest silo;
    private readonly GrpcChannel channel;

    private BroadcastsUnderTest(IsolatedDatabase db, SiloUnderTest silo, GrpcChannel channel, StubAuthority? owners)
    {
        Db = db;
        this.silo = silo;
        this.channel = channel;
        Owners = owners ?? new StubAuthority();
        Client = new NotificationsService.NotificationsServiceClient(channel);
    }

    public IsolatedDatabase Db { get; }

    public NotificationsService.NotificationsServiceClient Client { get; }

    /// <summary>Подставленные владельцы. У стенда без подстановки не участвуют.</summary>
    public StubAuthority Owners { get; }

    /// <summary>Стенд с подставленными владельцами права.</summary>
    public static Task<BroadcastsUnderTest> Start() => Launch(new StubAuthority());

    /// <summary>
    /// Стенд с composition root как есть: адреса Meetups и Identity не заданы,
    /// и сервис обязан отказать, а не разослать без проверки.
    /// </summary>
    public static Task<BroadcastsUnderTest> StartWithoutOwners() => Launch(owners: null);

    private static async Task<BroadcastsUnderTest> Launch(StubAuthority? owners)
    {
        var database = new IsolatedDatabase();
        SiloUnderTest? silo = null;

        try
        {
            Migrations.Apply(database.ConnectionString);
            silo = owners is null
                ? await SiloUnderTest.Start(database.ConnectionString)
                : await SiloUnderTest.StartWith(
                    database.ConnectionString,
                    services => services.AddSingleton<IBroadcastAuthority>(owners));

            return new BroadcastsUnderTest(database, silo, GrpcChannel.ForAddress(silo.Address), owners);
        }
        catch
        {
            if (silo is not null)
            {
                await silo.DisposeAsync();
            }

            database.Dispose();
            throw;
        }
    }

    /// <summary>Факты, порождённые рассылкой <paramref name="broadcastId" />.</summary>
    public async Task<IReadOnlyList<FactRow>> Facts(string broadcastId)
    {
        await using var connection = new NpgsqlConnection(Db.ConnectionString);
        var rows = await connection.QueryAsync<FactRow>(
            """
            SELECT recipient_id AS RecipientId, type AS Type, meetup_id AS MeetupId, request_id AS RequestId,
                   payload AS Payload
            FROM notification
            WHERE cause_kind = 'command_request' AND cause_id = @Id
            ORDER BY recipient_id;
            """,
            new { Id = broadcastId });

        return rows.ToList();
    }

    /// <summary>Сколько рассылок принято: отказ не должен оставлять ключ.</summary>
    public async Task<long> Accepted()
    {
        await using var connection = new NpgsqlConnection(Db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>("SELECT count(*) FROM broadcast;");
    }

    public async ValueTask DisposeAsync()
    {
        // Порядок и независимость шагов — как у PreferencesUnderTest: отказ
        // одного не должен оставить силос поднятым или базу неудалённой.
        try
        {
            channel.Dispose();
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"cleanup: {ex.Message}");
        }

        try
        {
            await silo.DisposeAsync();
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"cleanup: {ex.Message}");
        }

        Db.Dispose();
    }
}
