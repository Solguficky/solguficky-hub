using AppHost.Configuration;
using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

using static AppHost.UnitTests.TestUtilities.TestMappings;

namespace AppHost.UnitTests;

/// <summary>
/// Бот аукциона (ADR-044) на настоящем setup узла: свой токен и ни одной
/// переменной бота хаба, адреса Identity, Auction и Notifications, один токен
/// вызывающего со всеми вызываемыми, maintainer-секрета нет. Identity, Auction
/// и Notifications заменены дешёвыми узлами с тем же endpoint.
///
/// Модель настоящего AppHost здесь намеренно не собирается: в CI модели
/// профиля <c>auction-bot</c> в одном процессе с остальными наборами
/// стартовали по-настоящему, и снимок <c>hub</c> получал установщик с
/// <c>npm install</c> (PER-431).
/// </summary>
public class AuctionBotWiringTests
{
    private const string AuctionBot = AppHostNames.Resources.AuctionBot;
    private const string Identity = AppHostNames.Resources.Identity;
    private const string Auction = AppHostNames.Resources.Auction;
    private const string Notifications = AppHostNames.Resources.Notifications;
    private const string Nats = AppHostNames.Resources.Nats;

    private static readonly DistributedApplicationExecutionContext RunMode = new(DistributedApplicationOperation.Run);

    [Fact]
    public void AuctionBotProfile_OwnsTheBotWithItsCallees()
    {
        // Настоящий appsettings.json AppHost лежит в выходном каталоге теста.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Topology:Profile"] = "auction-bot" })
            .Build();

        var profile = ProfileResolver.Resolve(configuration);

        // Notifications — избранные лоты бота аукциона (PER-495).
        profile.Services.Order(StringComparer.Ordinal).ShouldBe([AppHostNames.Resources.Achievements, Auction, AuctionBot, Identity, Notifications]);
        profile.Infrastructure.Order(StringComparer.Ordinal).ShouldBe(["nats", "postgres"]);
    }

    /// <summary>
    /// Профиль живого прогона двух ботов — <c>hub</c> целиком плюс всё, чем
    /// владеет <c>auction-bot</c>, на той же инфраструктуре. Сам <c>hub</c>
    /// аукциона не получает: он по-прежнему не требует JDK.
    /// </summary>
    [Fact]
    public void HubAuctionProfile_IsHubPlusAuctionBotProfile()
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .Build();

        var hub = Resolve(configuration, "hub");
        var auctionBot = Resolve(configuration, "auction-bot");
        var hubAuction = Resolve(configuration, "hub-auction");

        hubAuction.Services.Order(StringComparer.Ordinal)
            .ShouldBe(hub.Services.Union(auctionBot.Services).Order(StringComparer.Ordinal));
        hubAuction.Infrastructure.Order(StringComparer.Ordinal)
            .ShouldBe(hub.Infrastructure.Order(StringComparer.Ordinal));
        hub.Services.ShouldNotContain(Auction);
        hub.Services.ShouldNotContain(AuctionBot);
    }

    private static ProfileConfig Resolve(IConfiguration configuration, string profile) =>
        ProfileResolver.Resolve(new ConfigurationBuilder()
            .AddConfiguration(configuration)
            .AddInMemoryCollection([new("profile", profile)])
            .Build());

    [Fact]
    public async Task AuctionBot_GetsOnlyItsOwnVariables()
    {
        var (bot, _) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment.Keys
            .Where(key => !key.StartsWith("OTEL_", StringComparison.Ordinal) && !key.StartsWith("NODE_", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray()
            .ShouldBe(
            [
                "AUCTION_GRPC_URL",
                "BOT_COMMUNITY_TIME_ZONE",
                "BOT_ENVIRONMENT",
                "BOT_NATS_URL",
                "BOT_SERVICE_TOKEN",
                "BOT_SURFACE",
                "BOT_TOKEN",
                "IDENTITY_GRPC_URL",
                "NOTIFICATIONS_GRPC_URL",
            ]);
        // Поверхность аукциона пакета ботов (ADR-064, п. 18): переменные общие
        // с ботом хаба, а значения — свои.
        environment["BOT_SURFACE"].ShouldBe("auction");
        ((ParameterResource)environment["BOT_TOKEN"]).Name.ShouldBe("auction-bot-token");
        environment["BOT_ENVIRONMENT"].ShouldBe("prod");
        environment["BOT_COMMUNITY_TIME_ZONE"].ShouldBe("Europe/Moscow");
        ((EndpointReference)environment["IDENTITY_GRPC_URL"]).Resource.Name.ShouldBe(Identity);
        ((EndpointReference)environment["AUCTION_GRPC_URL"]).Resource.Name.ShouldBe(Auction);
        ((EndpointReference)environment["NOTIFICATIONS_GRPC_URL"]).Resource.Name.ShouldBe(Notifications);
        environment["BOT_NATS_URL"].ShouldNotBeNull();
    }

    /// <summary>
    /// Профиль <c>auction-bot</c> Notifications не поднимает: бот живёт без
    /// настройки «перебили», а не ходит на чужой адрес (PER-515).
    /// </summary>
    [Fact]
    public async Task AuctionBot_WithoutNotifications_GetsNoNotificationsAddress()
    {
        var (bot, _) = Materialize("prod", withNotifications: false);
        var environment = await EnvironmentAsync(bot);

        environment.ShouldNotContainKey("NOTIFICATIONS_GRPC_URL");
        bot.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ShouldNotContain(Notifications);
    }

    [Fact]
    public void AuctionBot_WaitsForItsCallees()
    {
        var (bot, _) = Materialize("prod");

        var awaited = bot.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ToArray();

        awaited.ShouldContain(Identity);
        awaited.ShouldContain(Auction);
        awaited.ShouldContain(Notifications);
        // Шину бот ждёт вместе с топологией: durable и bucket журнала заводит
        // AppHost, а бот без них не стартует (PER-328).
        awaited.ShouldContain(Nats);
    }

    /// <summary>
    /// Токен вызывающего — один параметр реестра: тот же, который Identity и
    /// Auction берут в свою таблицу по имени бота.
    /// </summary>
    [Fact]
    public async Task AuctionBot_PresentsTheTokenItsCalleesAccept()
    {
        var (bot, context) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment["BOT_SERVICE_TOKEN"].ShouldBeSameAs(context.ServiceToken(AuctionBot).Resource);
    }

    /// <summary>
    /// Аукцион ленты из настройки снят (PER-453): бот читает списки аукционов
    /// из Auction, и оставшееся в user-secrets значение до него не доезжает.
    /// </summary>
    [Fact]
    public async Task AuctionBot_IgnoresAStaleAuctionSetting()
    {
        var (bot, _) = Materialize("prod", staleAuctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1");
        var environment = await EnvironmentAsync(bot);

        environment.ShouldNotContainKey("AUCTION_BOT_AUCTION_ID");
    }

    /// <summary>
    /// Вход в бот поддержки (ADR-068, п. 2): имя для кадра ожидания и готовая
    /// «Задать вопрос ↗» FAQ с меткой своего бота — код FAQ её уже читает.
    /// </summary>
    [Fact]
    public async Task AuctionBot_GetsTheSupportBotUsernameAndQuestionUrl()
    {
        var (bot, _) = Materialize("prod", supportBotUsername: " solguficky_support_bot ");
        var environment = await EnvironmentAsync(bot);

        environment["BOT_SUPPORT_BOT_USERNAME"].ShouldBe("solguficky_support_bot");
        environment["AUCTION_FAQ_QUESTION_URL"].ShouldBe("https://t.me/solguficky_support_bot?start=auction");
    }

    [Fact]
    public async Task AuctionBot_WithoutSupportBotUsername_GetsNeitherVariable()
    {
        var (bot, _) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment.ShouldNotContainKey("BOT_SUPPORT_BOT_USERNAME");
        environment.ShouldNotContainKey("AUCTION_FAQ_QUESTION_URL");
    }

    /// <summary>
    /// Канал медиа ботов (дополнение ADR-057 от 2026-10-27): гостю объявление со
    /// своим фото доставляет этот бот копией поста того же канала, что у хаба.
    /// </summary>
    [Fact]
    public async Task AuctionBot_GetsTheConfiguredMediaChannel()
    {
        var (bot, _) = Materialize("prod", mediaChannelId: " -1001234567890 ");
        var environment = await EnvironmentAsync(bot);

        environment["BOT_MEDIA_CHANNEL_ID"].ShouldBe("-1001234567890");
    }

    [Fact]
    public async Task AuctionBot_GetsAchievementsOnlyWhenTheProfileOwnsIt()
    {
        var (without, _) = Materialize("prod");
        (await EnvironmentAsync(without)).ShouldNotContainKey("ACHIEVEMENTS_GRPC_URL");
        var (with, _) = Materialize("prod", withAchievements: true);
        (await EnvironmentAsync(with)).ShouldContainKey("ACHIEVEMENTS_GRPC_URL");
        with.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name)
            .ShouldContain(AppHostNames.Resources.Achievements);
    }

    [Fact]
    public async Task AuctionBot_WithoutMediaChannel_GetsNoVariable()
    {
        var (bot, _) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment.ShouldNotContainKey("BOT_MEDIA_CHANNEL_ID");
    }

    [Fact]
    public async Task AuctionBot_TestEnvironment_TakesTheTestToken()
    {
        var (bot, _) = Materialize("test");
        var environment = await EnvironmentAsync(bot);

        ((ParameterResource)environment["BOT_TOKEN"]).Name.ShouldBe("auction-bot-test-token");
        environment["BOT_ENVIRONMENT"].ShouldBe("test");
    }

    /// <summary>Экран зала и стрим под карточкой лота бота (PER-825).</summary>
    [Fact]
    public async Task AuctionBot_GetsTheConfiguredHallLinks()
    {
        var (bot, _) = Materialize(
            "prod",
            hallScreenUrl: " https://hall.example.org/screen ",
            hallStreamUrl: "https://stream.example.org/live");
        var environment = await EnvironmentAsync(bot);

        environment["BOT_HALL_SCREEN_URL"].ShouldBe("https://hall.example.org/screen");
        environment["BOT_STREAM_URL"].ShouldBe("https://stream.example.org/live");
    }

    [Fact]
    public async Task AuctionBot_WithoutHallLinks_GetsNoVariables()
    {
        var (bot, _) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment.ShouldNotContainKey("BOT_HALL_SCREEN_URL");
        environment.ShouldNotContainKey("BOT_STREAM_URL");
    }

    private static (IResource Bot, ServiceGraphContext Context) Materialize(
        string telegramEnvironment,
        string? staleAuctionId = null,
        bool withNotifications = true,
        string? supportBotUsername = null,
        string? mediaChannelId = null,
        bool withAchievements = false,
        string? hallScreenUrl = null,
        string? hallStreamUrl = null)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests: тест видит только свою топологию.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Topology:Profiles:auction-bot:Services:0"] = Identity,
            ["Topology:Profiles:auction-bot:Services:1"] = Auction,
            ["Topology:Profiles:auction-bot:Services:2"] = AuctionBot,
            // Notifications владеет и свой профиль, как в appsettings.json AppHost.
            ["Topology:Profiles:notifications:Services:0"] = Notifications,
            ["Topology:Profiles:auction-bot:Infrastructure:0"] = Nats,
            ["telegram-environment"] = telegramEnvironment,
            ["Parameters:auction-bot-token"] = "111:auction",
            ["Parameters:auction-bot-test-token"] = "444:auction-test",
            ["Parameters:hub-bot-token"] = "222:hub",
            ["Parameters:hub-bot-test-token"] = "333:hub-test",
            ["AuctionBot:AuctionId"] = staleAuctionId,
            [SupportBotLink.UsernameKey] = supportBotUsername,
            [BotMediaChannel.ChannelIdKey] = mediaChannelId,
            [BotHallLinks.ScreenUrlKey] = hallScreenUrl,
            [BotHallLinks.StreamUrlKey] = hallStreamUrl,
        });
        if (withNotifications)
        {
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Topology:Profiles:auction-bot:Services:3"] = Notifications,
            });
        }

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Topology:Profiles:achievements:Services:0"] = AppHostNames.Resources.Achievements,
        });
        string[] services = withNotifications ? [Identity, Auction, Notifications, AuctionBot] : [Identity, Auction, AuctionBot];
        if (withAchievements) services = [.. services, AppHostNames.Resources.Achievements];
        var profile = new ProfileConfig { Name = "auction-bot", Services = [.. services], Infrastructure = [Nats] };
        var graph = new ServiceGraph(builder, profile);
        ServiceGraphContext? captured = null;

        // Шина — строка подключения, а не контейнер: тест видит привязку, а
        // ресурсов не запускает.
        graph.AddInfrastructure(Nats, context => context.Builder.AddConnectionString(Nats), LocalOnly);
        graph.AddService(Identity, [], context => CheapGrpcNode(context, Identity), LocalOnly);
        graph.AddService(Auction, [], context => CheapGrpcNode(context, Auction), LocalOnly);
        // Узел в графе есть всегда, а владеет им профиль или нет — как
        // Notifications в настоящих профилях auction-bot и hub-auction.
        graph.AddService(Notifications, [], context => CheapGrpcNode(context, Notifications), LocalOnly);
        graph.AddService(AppHostNames.Resources.Achievements, [], context => CheapGrpcNode(context, AppHostNames.Resources.Achievements), LocalOnly);
        graph.AddService(AuctionBot, [Nats, Identity, Auction, Notifications, AppHostNames.Resources.Achievements], context =>
        {
            captured = context;
            return AuctionBotSetup.Configure(context);
        }, LocalOnly);
        graph.Build();

        return (builder.Resources.Single(resource => resource.Name == AuctionBot), captured!);
    }

    private static IResourceBuilder<ContainerResource> CheapGrpcNode(ServiceGraphContext context, string name) =>
        context.Builder
            .AddContainer(name, "busybox")
            .WithHttpEndpoint(targetPort: 8080, name: AppHostNames.Endpoints.Grpc);

    private static async Task<Dictionary<string, object>> EnvironmentAsync(IResource resource)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var environment = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(new EnvironmentCallbackContext(RunMode, resource, environment, cancellationToken));
        }

        return environment;
    }
}
