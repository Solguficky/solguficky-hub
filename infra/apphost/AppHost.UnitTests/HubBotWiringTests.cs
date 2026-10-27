using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Имя бота аукциона для ссылок каналов прихода (PER-441), имя бота поддержки
/// (ADR-068, п. 2) и канал медиа ботов — необязательные настройки: заданная
/// доезжает до бота хаба, незаданная не появляется вовсе.
/// </summary>
public class HubBotWiringTests
{
    private static readonly DistributedApplicationExecutionContext RunMode = new(DistributedApplicationOperation.Run);

    [Fact]
    public async Task HubBot_GetsTheConfiguredAuctionBotUsername()
    {
        var environment = await EnvironmentAsync(" solguficky_auction_bot ");

        environment["BOT_AUCTION_BOT_USERNAME"].ShouldBe("solguficky_auction_bot");
    }

    [Fact]
    public async Task HubBot_WithoutAuctionBotUsername_GetsNoVariable()
    {
        var environment = await EnvironmentAsync(null);

        environment.ShouldNotContainKey("BOT_AUCTION_BOT_USERNAME");
    }

    /// <summary>Вход в бот поддержки из «Помощи» (ADR-068, п. 2).</summary>
    [Fact]
    public async Task HubBot_GetsTheConfiguredSupportBotUsername()
    {
        var environment = await EnvironmentAsync(null, " solguficky_support_bot ");

        environment["BOT_SUPPORT_BOT_USERNAME"].ShouldBe("solguficky_support_bot");
    }

    [Fact]
    public async Task HubBot_WithoutSupportBotUsername_GetsNoVariable()
    {
        var environment = await EnvironmentAsync(null);

        environment.ShouldNotContainKey("BOT_SUPPORT_BOT_USERNAME");
    }

    /// <summary>Канал медиа ботов (дополнение ADR-057 от 2026-10-27).</summary>
    [Fact]
    public async Task HubBot_GetsTheConfiguredMediaChannel()
    {
        var environment = await EnvironmentAsync(null, mediaChannelId: " -1001234567890 ");

        environment["BOT_MEDIA_CHANNEL_ID"].ShouldBe("-1001234567890");
    }

    /// <summary>Без канала медиа выключены, а бот стартует как прежде.</summary>
    [Fact]
    public async Task HubBot_WithoutMediaChannel_GetsNoVariable()
    {
        var environment = await EnvironmentAsync(null);

        environment.ShouldNotContainKey("BOT_MEDIA_CHANNEL_ID");
    }

    private static async Task<Dictionary<string, object>> EnvironmentAsync(
        string? auctionBotUsername,
        string? supportBotUsername = null,
        string? mediaChannelId = null)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Parameters:hub-bot-token"] = "222:hub",
            [HubBotSetup.AuctionBotUsernameKey] = auctionBotUsername,
            [SupportBotLink.UsernameKey] = supportBotUsername,
            [BotMediaChannel.ChannelIdKey] = mediaChannelId,
        });
        var profile = new ProfileConfig { Name = "hub", Services = ["hub-bot"], Infrastructure = [] };
        var bot = HubBotSetup.Configure(new ServiceGraphContext(builder, profile)).Resource;

        var cancellationToken = TestContext.Current.CancellationToken;
        var environment = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var callback in bot.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(new EnvironmentCallbackContext(RunMode, bot, environment, cancellationToken));
        }

        return environment;
    }
}
