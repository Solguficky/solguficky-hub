using Grpc.Core;
using Grpc.Net.Client;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Чтение и запись настройки перебитий через настоящую границу сервиса
/// (PER-514). Вызывающий — бот аукциона: экран настройки живёт в нём (PER-515).
/// </summary>
public class OutbidPreferenceTests
{
    [Fact]
    public async Task When_PersonNeverSetFrequency_Expect_EveryOutbid()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var preference = await client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId });

        preference.IdentityId.ShouldBe(identityId);
        preference.Frequency.ShouldBe(OutbidFrequency.Every);
    }

    [Fact]
    public async Task When_FrequencySetTwice_Expect_LastValueAnsweredAndRead()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        await client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.Off,
        });
        var answered = await client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.AtMostEvery15Minutes,
        });
        var read = await client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId });

        answered.Frequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
        read.ShouldBe(answered);
    }

    [Fact]
    public async Task When_FrequencyUnspecified_Expect_InvalidArgumentAndNothingStored()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest { IdentityId = identityId }));

        declined.StatusCode.ShouldBe(StatusCode.InvalidArgument);
        (await client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId }))
            .Frequency.ShouldBe(OutbidFrequency.Every);
    }

    /// <summary>Бот хаба экрана настройки не держит, и метод ему закрыт (ADR-056).</summary>
    [Fact]
    public async Task When_HubBotSetsFrequency_Expect_UnauthenticatedAndNothingStored()
    {
        await using var service = await PreferencesUnderTest.Start();
        var identityId = Guid.CreateVersion7().ToString("D");

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await service.Client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
            {
                IdentityId = identityId,
                Frequency = OutbidFrequency.Off,
            }));

        declined.StatusCode.ShouldBe(StatusCode.Unauthenticated);
        (await service.ClientPresenting(SiloUnderTest.AuctionBotToken)
                .GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId }))
            .Frequency.ShouldBe(OutbidFrequency.Every);
    }

    /// <summary>
    /// Выбор живёт в базе сервиса, а не в силосе: новый силос на той же базе
    /// отвечает тем же значением (критерий PER-515).
    /// </summary>
    [Fact]
    public async Task When_ServiceRestarts_Expect_FrequencyKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        var identityId = Guid.CreateVersion7().ToString("D");

        await using (var silo = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(silo.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));
            await client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
            {
                IdentityId = identityId,
                Frequency = OutbidFrequency.AtMostEvery60Minutes,
            });
        }

        await using (var restarted = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(restarted.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));

            (await client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId }))
                .Frequency.ShouldBe(OutbidFrequency.AtMostEvery60Minutes);
        }
    }
}
