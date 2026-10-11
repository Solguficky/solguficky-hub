using Grpc.Core;
using Grpc.Net.Client;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Отметка «пояснение автоставки видено» через настоящую границу сервиса
/// (PER-517). Вопрос лимита есть у обоих ботов, и оба читают и ставят одну
/// отметку человека.
/// </summary>
public class ProxyExplainerTests
{
    [Fact]
    public async Task When_PersonNeverMarked_Expect_NotSeen()
    {
        await using var service = await PreferencesUnderTest.Start();
        var identityId = Guid.CreateVersion7().ToString("D");

        var explainer = await service.Client.GetProxyExplainerAsync(
            new GetProxyExplainerRequest { IdentityId = identityId });

        explainer.IdentityId.ShouldBe(identityId);
        explainer.Seen.ShouldBeFalse();
    }

    /// <summary>
    /// Отметка у человека одна: поставил её один бот — другой читает её же, а
    /// повтор отметки отказом не является.
    /// </summary>
    [Fact]
    public async Task When_MarkedTwiceByEitherBot_Expect_SeenForBoth()
    {
        await using var service = await PreferencesUnderTest.Start();
        var auctionBot = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var marked = await auctionBot.MarkProxyExplainerSeenAsync(
            new MarkProxyExplainerSeenRequest { IdentityId = identityId });
        var repeated = await service.Client.MarkProxyExplainerSeenAsync(
            new MarkProxyExplainerSeenRequest { IdentityId = identityId });
        var read = await service.Client.GetProxyExplainerAsync(
            new GetProxyExplainerRequest { IdentityId = identityId });

        marked.Seen.ShouldBeTrue();
        repeated.ShouldBe(marked);
        read.ShouldBe(marked);
    }

    [Fact]
    public async Task When_IdentityIdNotCanonical_Expect_InvalidArgument()
    {
        await using var service = await PreferencesUnderTest.Start();

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await service.Client.MarkProxyExplainerSeenAsync(
                new MarkProxyExplainerSeenRequest { IdentityId = "not-a-uuid" }));

        declined.StatusCode.ShouldBe(StatusCode.InvalidArgument);
    }

    /// <summary>Отметка живёт в базе сервиса, а не в силосе.</summary>
    [Fact]
    public async Task When_ServiceRestarts_Expect_MarkKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        var identityId = Guid.CreateVersion7().ToString("D");

        await using (var silo = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(silo.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));
            await client.MarkProxyExplainerSeenAsync(new MarkProxyExplainerSeenRequest { IdentityId = identityId });
        }

        await using (var restarted = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(restarted.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));

            (await client.GetProxyExplainerAsync(new GetProxyExplainerRequest { IdentityId = identityId }))
                .Seen.ShouldBeTrue();
        }
    }
}
