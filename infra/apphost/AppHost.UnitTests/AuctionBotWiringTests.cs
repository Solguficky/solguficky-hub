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
/// переменной бота хаба, адреса Identity и Auction, один токен вызывающего с
/// обоими вызываемыми, maintainer-секрета нет. Identity и Auction заменены
/// дешёвыми узлами с тем же endpoint.
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
    private const string Nats = AppHostNames.Resources.Nats;

    private static readonly DistributedApplicationExecutionContext RunMode = new(DistributedApplicationOperation.Run);

    [Fact]
    public void AuctionBotProfile_OwnsTheBotWithIdentityAndAuction()
    {
        // Настоящий appsettings.json AppHost лежит в выходном каталоге теста.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Topology:Profile"] = "auction-bot" })
            .Build();

        var profile = ProfileResolver.Resolve(configuration);

        profile.Services.Order(StringComparer.Ordinal).ShouldBe([Auction, AuctionBot, Identity]);
        profile.Infrastructure.Order(StringComparer.Ordinal).ShouldBe(["nats", "postgres"]);
    }

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
                "AUCTION_BOT_COMMUNITY_TIME_ZONE",
                "AUCTION_BOT_ENVIRONMENT",
                "AUCTION_BOT_NATS_URL",
                "AUCTION_BOT_SERVICE_TOKEN",
                "AUCTION_BOT_TOKEN",
                "AUCTION_GRPC_URL",
                "IDENTITY_GRPC_URL",
            ]);
        ((ParameterResource)environment["AUCTION_BOT_TOKEN"]).Name.ShouldBe("auction-bot-token");
        environment["AUCTION_BOT_ENVIRONMENT"].ShouldBe("prod");
        environment["AUCTION_BOT_COMMUNITY_TIME_ZONE"].ShouldBe("Europe/Moscow");
        ((EndpointReference)environment["IDENTITY_GRPC_URL"]).Resource.Name.ShouldBe(Identity);
        ((EndpointReference)environment["AUCTION_GRPC_URL"]).Resource.Name.ShouldBe(Auction);
        environment["AUCTION_BOT_NATS_URL"].ShouldNotBeNull();
    }

    [Fact]
    public void AuctionBot_WaitsForIdentityAndAuction()
    {
        var (bot, _) = Materialize("prod");

        var awaited = bot.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ToArray();

        awaited.ShouldContain(Identity);
        awaited.ShouldContain(Auction);
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

        environment["AUCTION_BOT_SERVICE_TOKEN"].ShouldBeSameAs(context.ServiceToken(AuctionBot).Resource);
    }

    /// <summary>
    /// Аукцион ленты — необязательная настройка: заданная доезжает до бота,
    /// незаданная не появляется вовсе (тест выше).
    /// </summary>
    [Fact]
    public async Task AuctionBot_GetsTheConfiguredAuction()
    {
        var (bot, _) = Materialize("prod", auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1");
        var environment = await EnvironmentAsync(bot);

        environment["AUCTION_BOT_AUCTION_ID"].ShouldBe("01929b7e-5c1d-7a3f-8e4b-0000000000a1");
    }

    [Fact]
    public async Task AuctionBot_TestEnvironment_TakesTheTestToken()
    {
        var (bot, _) = Materialize("test");
        var environment = await EnvironmentAsync(bot);

        ((ParameterResource)environment["AUCTION_BOT_TOKEN"]).Name.ShouldBe("auction-bot-test-token");
        environment["AUCTION_BOT_ENVIRONMENT"].ShouldBe("test");
    }

    private static (IResource Bot, ServiceGraphContext Context) Materialize(
        string telegramEnvironment, string? auctionId = null)
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
            ["Topology:Profiles:auction-bot:Infrastructure:0"] = Nats,
            ["telegram-environment"] = telegramEnvironment,
            ["Parameters:auction-bot-token"] = "111:auction",
            ["Parameters:auction-bot-test-token"] = "444:auction-test",
            ["Parameters:hub-bot-token"] = "222:hub",
            ["Parameters:hub-bot-test-token"] = "333:hub-test",
            [AuctionBotSetup.AuctionIdKey] = auctionId,
        });

        var profile = new ProfileConfig { Name = "auction-bot", Services = [Identity, Auction, AuctionBot], Infrastructure = [Nats] };
        var graph = new ServiceGraph(builder, profile);
        ServiceGraphContext? captured = null;

        // Шина — строка подключения, а не контейнер: тест видит привязку, а
        // ресурсов не запускает.
        graph.AddInfrastructure(Nats, context => context.Builder.AddConnectionString(Nats), LocalOnly);
        graph.AddService(Identity, [], context => CheapGrpcNode(context, Identity), LocalOnly);
        graph.AddService(Auction, [], context => CheapGrpcNode(context, Auction), LocalOnly);
        graph.AddService(AuctionBot, [Nats, Identity, Auction], context =>
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
