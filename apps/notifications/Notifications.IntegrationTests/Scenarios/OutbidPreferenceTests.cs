using Grpc.Core;
using Grpc.Net.Client;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Чтение и запись настройки перебитий через настоящую границу сервиса
/// (PER-514). Вызывающие — оба бота: экран настройки есть у бота аукциона
/// (PER-515) и у бота хаба (PER-552).
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

    /// <summary>
    /// Настройка у человека одна (PER-552): гость выбрал «не присылать» в боте
    /// аукциона, получил право хаба — и бот хаба читает тот же выбор и меняет его.
    /// </summary>
    [Fact]
    public async Task When_GuestChoseInAuctionBot_Expect_HubBotReadsAndChangesIt()
    {
        await using var service = await PreferencesUnderTest.Start();
        var auctionBot = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");
        await auctionBot.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.Off,
        });

        var seen = await service.Client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId });
        var changed = await service.Client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.AtMostEvery15Minutes,
        });

        seen.Frequency.ShouldBe(OutbidFrequency.Off);
        changed.Frequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
        (await auctionBot.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId }))
            .Frequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
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
