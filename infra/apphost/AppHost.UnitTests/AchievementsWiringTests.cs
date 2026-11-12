using AppHost.Configuration;
using AppHost.Configuration.Infrastructure;
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
/// Achievements (ADR-077) на настоящем setup узла: своя база, адрес шины для
/// релея outbox и порт gRPC под ключами, которые читает config/runtime.exs.
/// Модель настоящего AppHost не собирается по той же причине, что в
/// <see cref="SupportBotWiringTests"/>.
/// </summary>
public class AchievementsWiringTests
{
    private const string Achievements = AppHostNames.Resources.Achievements;
    private const string Postgres = AppHostNames.Resources.Postgres;
    private const string Nats = AppHostNames.Resources.Nats;

    private static readonly DistributedApplicationExecutionContext RunMode = new(DistributedApplicationOperation.Run);

    [Fact]
    public void AchievementsProfile_OwnsTheServiceWithItsStores()
    {
        // Настоящий appsettings.json AppHost лежит в выходном каталоге теста.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Topology:Profile"] = "achievements" })
            .Build();

        var profile = ProfileResolver.Resolve(configuration);

        profile.Services.ShouldBe([Achievements]);
        profile.Infrastructure.Order(StringComparer.Ordinal).ShouldBe([Nats, Postgres]);
    }

    [Fact]
    public async Task Achievements_GetsOnlyItsOwnVariables()
    {
        var achievements = Materialize(withBus: true);
        var environment = await EnvironmentAsync(achievements);

        environment.Keys
            .Where(key => !key.StartsWith("OTEL_", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray()
            .ShouldBe([
                // Таблица вызывающих полна и в одиночном профиле (ADR-056): колонка
                // Caller раздела «Achievements gRPC» integration.md.
                "ACHIEVEMENTS_CALLER_TOKEN_AUCTION_BOT",
                "ACHIEVEMENTS_CALLER_TOKEN_HUB_BOT",
                "ACHIEVEMENTS_DATABASE_URL",
                "ACHIEVEMENTS_GRPC_PORT",
                "ACHIEVEMENTS_NATS_URL",
                "ELIXIR_ERL_OPTIONS"
            ]);
        // Исполняемый файл получает адрес OTLP только явным экспортёром.
        environment.Keys.ShouldContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    }

    /// <summary>
    /// Без узла шины сервис поднимается без релея: строки ждут в outbox.
    /// </summary>
    [Fact]
    public async Task Achievements_WithoutTheBus_GetsNoBusAddress()
    {
        var achievements = Materialize(withBus: false);
        var environment = await EnvironmentAsync(achievements);

        environment.Keys.ShouldNotContain("ACHIEVEMENTS_NATS_URL");
        environment.Keys.ShouldContain("ACHIEVEMENTS_DATABASE_URL");
    }

    [Fact]
    public void Achievements_WaitsForItsDatabaseAndBuild()
    {
        var achievements = Materialize(withBus: true);

        var awaited = achievements.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ToArray();

        awaited.ShouldContain(AppHostNames.Resources.AchievementsDb);
        awaited.ShouldContain("achievements-build");
    }

    /// <summary>
    /// Сгенерированного кода в Git нет: без шага кодогенерации до сборки
    /// `mix compile` свежего дерева не нашёл бы модулей контракта.
    /// </summary>
    [Fact]
    public void AchievementsBuild_WaitsForCodegen()
    {
        var build = Materialize(withBus: true, name: "achievements-build");

        build.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name).ShouldContain("achievements-proto");
    }

    private static IResource Materialize(bool withBus, string name = Achievements)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests: тест видит только свою топологию.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Topology:Profiles:achievements:Services:0"] = Achievements,
            ["Topology:Profiles:achievements:Infrastructure:0"] = Postgres,
            ["Topology:Profiles:achievements:Infrastructure:1"] = Nats,
        });

        string[] infrastructure = withBus ? [Postgres, Nats] : [Postgres];
        var profile = new ProfileConfig { Name = "achievements", Services = [Achievements], Infrastructure = [.. infrastructure] };
        var graph = new ServiceGraph(builder, profile);

        graph.AddInfrastructure(Postgres, PostgresSetup.Configure, LocalOnly);
        graph.AddInfrastructure(Nats, context => context.Builder.AddConnectionString(Nats), LocalOnly);
        graph.AddService(Achievements, [Postgres, Nats], AchievementsSetup.Configure, LocalOnly);
        graph.Build();

        return builder.Resources.Single(resource => resource.Name == name);
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
