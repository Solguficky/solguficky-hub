using Grpc.Core;
using Grpc.Net.Client;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Чтение и запись настроек уведомлений аукциона через настоящую границу
/// сервиса: частота перебитий (PER-514) и выключатель анонса финала (PER-539).
/// Вызывающие — оба бота: экран настроек есть у бота аукциона (PER-515) и у
/// бота хаба (PER-552).
/// </summary>
public class AuctionNotificationPreferencesTests
{
    [Fact]
    public async Task When_PersonNeverSetAnything_Expect_EveryOutbidAndFinalAnnouncements()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var preferences = await client.GetAuctionNotificationPreferencesAsync(
            new GetAuctionNotificationPreferencesRequest { IdentityId = identityId });

        preferences.IdentityId.ShouldBe(identityId);
        preferences.OutbidFrequency.ShouldBe(OutbidFrequency.Every);
        preferences.FinalAnnouncements.ShouldBeTrue();
    }

    [Fact]
    public async Task When_FrequencySetTwice_Expect_LastValueAnsweredAndRead()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
        {
            IdentityId = identityId,
            OutbidFrequency = OutbidFrequency.Off,
        });
        var answered = await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
        {
            IdentityId = identityId,
            OutbidFrequency = OutbidFrequency.AtMostEvery15Minutes,
        });
        var read = await client.GetAuctionNotificationPreferencesAsync(
            new GetAuctionNotificationPreferencesRequest { IdentityId = identityId });

        answered.OutbidFrequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
        read.ShouldBe(answered);
    }

    /// <summary>Неназванная настройка не меняется: выключатель финала частоту не трогает и наоборот.</summary>
    [Fact]
    public async Task When_OnlyFinalSet_Expect_FrequencyKept()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");
        await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
        {
            IdentityId = identityId,
            OutbidFrequency = OutbidFrequency.AtMostEvery5Minutes,
        });

        var answered = await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
        {
            IdentityId = identityId,
            FinalAnnouncements = false,
        });

        answered.OutbidFrequency.ShouldBe(OutbidFrequency.AtMostEvery5Minutes);
        answered.FinalAnnouncements.ShouldBeFalse();
    }

    [Fact]
    public async Task When_NothingNamed_Expect_InvalidArgumentAndNothingStored()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await client.SetAuctionNotificationPreferencesAsync(
                new SetAuctionNotificationPreferencesRequest { IdentityId = identityId }));

        declined.StatusCode.ShouldBe(StatusCode.InvalidArgument);
        var read = await client.GetAuctionNotificationPreferencesAsync(
            new GetAuctionNotificationPreferencesRequest { IdentityId = identityId });
        read.OutbidFrequency.ShouldBe(OutbidFrequency.Every);
        read.FinalAnnouncements.ShouldBeTrue();
    }

    [Fact]
    public async Task When_FrequencyUnspecified_Expect_InvalidArgumentAndNothingStored()
    {
        await using var service = await PreferencesUnderTest.Start();
        var client = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
            {
                IdentityId = identityId,
                OutbidFrequency = OutbidFrequency.Unspecified,
                FinalAnnouncements = false,
            }));

        declined.StatusCode.ShouldBe(StatusCode.InvalidArgument);
        (await client.GetAuctionNotificationPreferencesAsync(
                new GetAuctionNotificationPreferencesRequest { IdentityId = identityId }))
            .FinalAnnouncements.ShouldBeTrue();
    }

    /// <summary>
    /// Настройки у человека одни (PER-552): гость выбрал в боте аукциона,
    /// получил право хаба — и бот хаба читает тот же выбор и меняет его.
    /// </summary>
    [Fact]
    public async Task When_GuestChoseInAuctionBot_Expect_HubBotReadsAndChangesIt()
    {
        await using var service = await PreferencesUnderTest.Start();
        var auctionBot = service.ClientPresenting(SiloUnderTest.AuctionBotToken);
        var identityId = Guid.CreateVersion7().ToString("D");
        await auctionBot.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
        {
            IdentityId = identityId,
            OutbidFrequency = OutbidFrequency.Off,
            FinalAnnouncements = false,
        });

        var seen = await service.Client.GetAuctionNotificationPreferencesAsync(
            new GetAuctionNotificationPreferencesRequest { IdentityId = identityId });
        var changed = await service.Client.SetAuctionNotificationPreferencesAsync(
            new SetAuctionNotificationPreferencesRequest
            {
                IdentityId = identityId,
                OutbidFrequency = OutbidFrequency.AtMostEvery15Minutes,
            });

        seen.OutbidFrequency.ShouldBe(OutbidFrequency.Off);
        seen.FinalAnnouncements.ShouldBeFalse();
        changed.OutbidFrequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
        (await auctionBot.GetAuctionNotificationPreferencesAsync(
                new GetAuctionNotificationPreferencesRequest { IdentityId = identityId }))
            .ShouldBe(changed);
    }

    /// <summary>
    /// Выбор живёт в базе сервиса, а не в силосе: новый силос на той же базе
    /// отвечает тем же значением (критерии PER-515 и PER-539).
    /// </summary>
    [Fact]
    public async Task When_ServiceRestarts_Expect_PreferencesKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        var identityId = Guid.CreateVersion7().ToString("D");

        await using (var silo = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(silo.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));
            await client.SetAuctionNotificationPreferencesAsync(new SetAuctionNotificationPreferencesRequest
            {
                IdentityId = identityId,
                OutbidFrequency = OutbidFrequency.AtMostEvery60Minutes,
                FinalAnnouncements = false,
            });
        }

        await using (var restarted = await SiloUnderTest.Start(db.ConnectionString))
        {
            using var channel = GrpcChannel.ForAddress(restarted.Address);
            var client = new NotificationsService.NotificationsServiceClient(
                SiloUnderTest.Presenting(channel, SiloUnderTest.AuctionBotToken));

            var read = await client.GetAuctionNotificationPreferencesAsync(
                new GetAuctionNotificationPreferencesRequest { IdentityId = identityId });
            read.OutbidFrequency.ShouldBe(OutbidFrequency.AtMostEvery60Minutes);
            read.FinalAnnouncements.ShouldBeFalse();
        }
    }
}
