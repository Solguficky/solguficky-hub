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
/// Бот поддержки (ADR-068) на настоящем setup узла: свой токен и своя группа
/// операторов, адрес одной Identity, шина ради bucket'а пар и токен
/// вызывающего, который принимает Identity. Identity заменена дешёвым узлом с
/// тем же endpoint, модель настоящего AppHost не собирается по той же причине,
/// что в <see cref="AuctionBotWiringTests"/>.
/// </summary>
public class SupportBotWiringTests
{
    private const string SupportBot = AppHostNames.Resources.SupportBot;
    private const string Identity = AppHostNames.Resources.Identity;
    private const string Nats = AppHostNames.Resources.Nats;

    private static readonly DistributedApplicationExecutionContext RunMode = new(DistributedApplicationOperation.Run);

    [Fact]
    public void SupportBotProfile_OwnsTheBotWithIdentity()
    {
        // Настоящий appsettings.json AppHost лежит в выходном каталоге теста.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Topology:Profile"] = "support-bot" })
            .Build();

        var profile = ProfileResolver.Resolve(configuration);

        profile.Services.Order(StringComparer.Ordinal).ShouldBe([Identity, SupportBot]);
        profile.Infrastructure.Order(StringComparer.Ordinal).ShouldBe(["nats", "postgres"]);
    }

    /// <summary>
    /// Бот поддержки отвечает рядом с ботом каждого человека (ADR-068, п. 10),
    /// поэтому локальный стенд хаба поднимает его вместе с ботом хаба.
    /// </summary>
    [Fact]
    public void HubProfile_OwnsTheSupportBot()
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Topology:Profile"] = "hub" })
            .Build();

        ProfileResolver.Resolve(configuration).Services.ShouldContain(SupportBot);
    }

    [Fact]
    public async Task SupportBot_GetsOnlyItsOwnVariables()
    {
        var (bot, _) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment.Keys
            .Where(key => !key.StartsWith("OTEL_", StringComparison.Ordinal) && !key.StartsWith("NODE_", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray()
            .ShouldBe(
            [
                "BOT_COMMUNITY_TIME_ZONE",
                "BOT_ENVIRONMENT",
                "BOT_NATS_URL",
                "BOT_SERVICE_TOKEN",
                "BOT_SUPPORT_GROUP_ID",
                "BOT_SURFACE",
                "BOT_TOKEN",
                "IDENTITY_GRPC_URL",
            ]);
        environment["BOT_SURFACE"].ShouldBe("support");
        ((ParameterResource)environment["BOT_TOKEN"]).Name.ShouldBe("support-bot-token");
        var group = (ParameterResource)environment["BOT_SUPPORT_GROUP_ID"];
        group.Name.ShouldBe("support-bot-group-id");
        // Id группы без членства в ней переписки не открывает.
        group.Secret.ShouldBeFalse();
        environment["BOT_ENVIRONMENT"].ShouldBe("prod");
        ((EndpointReference)environment["IDENTITY_GRPC_URL"]).Resource.Name.ShouldBe(Identity);
        environment["BOT_NATS_URL"].ShouldNotBeNull();
    }

    [Fact]
    public void SupportBot_WaitsForIdentityAndTheBus()
    {
        var (bot, _) = Materialize("prod");

        var awaited = bot.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ToArray();

        awaited.ShouldContain(Identity);
        // Шину бот ждёт вместе с топологией: bucket пар заводит AppHost, а бот
        // без него не стартует (ADR-068, п. 8).
        awaited.ShouldContain(Nats);
    }

    /// <summary>
    /// Токен вызывающего — один параметр реестра: тот же, который Identity
    /// берёт в свою таблицу по имени бота.
    /// </summary>
    [Fact]
    public async Task SupportBot_PresentsTheTokenIdentityAccepts()
    {
        var (bot, context) = Materialize("prod");
        var environment = await EnvironmentAsync(bot);

        environment["BOT_SERVICE_TOKEN"].ShouldBeSameAs(context.ServiceToken(SupportBot).Resource);
    }

    [Fact]
    public async Task SupportBot_TestEnvironment_TakesTheTestTokenAndGroup()
    {
        var (bot, _) = Materialize("test");
        var environment = await EnvironmentAsync(bot);

        ((ParameterResource)environment["BOT_TOKEN"]).Name.ShouldBe("support-bot-test-token");
        ((ParameterResource)environment["BOT_SUPPORT_GROUP_ID"]).Name.ShouldBe("support-bot-test-group-id");
        environment["BOT_ENVIRONMENT"].ShouldBe("test");
    }

    private static (IResource Bot, ServiceGraphContext Context) Materialize(string telegramEnvironment)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests: тест видит только свою топологию.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Topology:Profiles:support-bot:Services:0"] = Identity,
            ["Topology:Profiles:support-bot:Services:1"] = SupportBot,
            ["Topology:Profiles:support-bot:Infrastructure:0"] = Nats,
            ["telegram-environment"] = telegramEnvironment,
            ["Parameters:support-bot-token"] = "555:support",
            ["Parameters:support-bot-test-token"] = "666:support-test",
        });

        var profile = new ProfileConfig { Name = "support-bot", Services = [Identity, SupportBot], Infrastructure = [Nats] };
        var graph = new ServiceGraph(builder, profile);
        ServiceGraphContext? captured = null;

        graph.AddInfrastructure(Nats, context => context.Builder.AddConnectionString(Nats), LocalOnly);
        graph.AddService(Identity, [], context => context.Builder
            .AddContainer(Identity, "busybox")
            .WithHttpEndpoint(targetPort: 8080, name: AppHostNames.Endpoints.Grpc), LocalOnly);
        graph.AddService(SupportBot, [Nats, Identity], context =>
        {
            captured = context;
            return SupportBotSetup.Configure(context);
        }, LocalOnly);
        graph.Build();

        return (builder.Resources.Single(resource => resource.Name == SupportBot), captured!);
    }

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
