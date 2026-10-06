using AppHost.Configuration;
using AppHost.Configuration.Infrastructure;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Kubernetes;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.Configuration;
using AppHost.UnitTests.TestUtilities;
using Shouldly;
using Xunit;

using R = AppHost.Configuration.AppHostNames.Resources;

namespace AppHost.UnitTests;

/// <summary>
/// Граф настоящего AppHost в режиме публикации — то, из чего генератор строит
/// чарт (ADR-055). Генератор публикует workload'ом каждый compute-ресурс модели,
/// поэтому состав модели и есть состав чарта: проверка здесь ловит лишний и
/// выпавший workload до <c>helm template</c>.
/// </summary>
[Collection(RealAppHostCollection.Name)]
public class ClusterPublishTests
{
    private static async Task<IDistributedApplicationTestingBuilder> PublishModelAsync()
    {
        var output = Path.Combine(Path.GetTempPath(), $"apphost-publish-{Guid.NewGuid():N}");
        return await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(
            ["--operation", "publish", "--publisher", "default", "--output-path", output],
            TestContext.Current.CancellationToken);
    }

    /// <summary>
    /// Кроме сервисов в модели один compute-ресурс — Job топологии JetStream,
    /// которым владеет публикация NATS (PER-311).
    /// </summary>
    [Fact]
    public async Task Publish_Workloads_AreTheFourMvpServicesAuctionAndTopologyJob()
    {
        var builder = await PublishModelAsync();

        builder.ExecutionContext.IsPublishMode.ShouldBeTrue();
        builder.Resources.OfType<IComputeResource>()
            .Select(resource => resource.Name)
            .Order(StringComparer.Ordinal)
            .ShouldBe([R.Auction, R.HubBot, R.Identity, NatsSetup.TopologyJobName, R.Meetups, R.Notifications]);
    }

    /// <summary>
    /// Identity, бот и Auction собираются по своим Containerfile из корня
    /// репозитория, а не цепочкой buf/go build, sbt и голой JVM и не контейнером,
    /// который Aspire сгенерировал бы из <c>AddJavaScriptApp</c>: их кодогенерации
    /// нужен <c>contracts/proto</c>.
    /// </summary>
    [Theory]
    [InlineData(R.Identity, "apps/identity/Containerfile")]
    [InlineData(R.HubBot, "apps/hub-bot/Containerfile")]
    [InlineData(R.Auction, "apps/auction/Containerfile")]
    public async Task Publish_ContainerfileServices_BuildFromRepositoryRoot(string name, string containerfile)
    {
        var builder = await PublishModelAsync();
        var root = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../../.."));

        var resource = builder.Resources.Single(resource => resource.Name == name);

        resource.ShouldBeOfType<ContainerResource>();
        var build = resource.Annotations.OfType<DockerfileBuildAnnotation>().ShouldHaveSingleItem();
        Path.GetFullPath(build.ContextPath).ShouldBe(root);
        Path.GetFullPath(build.DockerfilePath).ShouldBe(Path.GetFullPath(Path.Combine(root, containerfile)));
        // Перенос Containerfile без правки графа дал бы чарт, образ которого CI
        // соберёт по другому пути, — или не соберёт вовсе.
        File.Exists(build.DockerfilePath).ShouldBeTrue();
    }

    [Fact]
    public async Task Publish_Infrastructure_IsConnectionStringsUnderLocalNames()
    {
        var builder = await PublishModelAsync();

        builder.Resources.OfType<PostgresServerResource>().ShouldBeEmpty();
        builder.Resources.OfType<NatsServerResource>().ShouldBeEmpty();
        builder.Resources.OfType<IResourceWithConnectionString>()
            .Select(resource => resource.Name)
            .Order(StringComparer.Ordinal)
            .ShouldBe([R.AuctionDb, R.IdentityDb, R.MeetupsDb, R.Nats, R.NotificationsDb]);
    }

    [Fact]
    public async Task Publish_KubernetesEnvironment_HasNoDashboard()
    {
        var builder = await PublishModelAsync();

        var environment = builder.Resources.OfType<KubernetesEnvironmentResource>().ShouldHaveSingleItem();
        environment.DashboardEnabled.ShouldBeFalse();
    }

    /// <summary>
    /// Чарт собирается из <c>cluster</c>, а локальный стенд — из <c>hub</c>.
    /// Расхождение составов — решение, которое должно быть видно правкой этого
    /// теста, а не тихо приехать в прод вместе с изменением локального профиля.
    /// Единственное расхождение — Auction: stage поднимает аукцион вместе с хабом
    /// (дополнение к ADR-055), а локальный <c>hub</c> JVM не тянет, и аукцион
    /// поднимают его профили <c>auction</c> и <c>auction-bot</c>.
    /// </summary>
    [Fact]
    public void PublishProfile_MatchesHubComposition()
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .Build();

        var cluster = ProfileResolver.PublishProfile(configuration).ShouldNotBeNull();
        var hub = ProfileResolver.Resolve(new ConfigurationBuilder()
            .AddConfiguration(configuration)
            .AddInMemoryCollection([new("profile", "hub")])
            .Build());

        cluster.Name.ShouldBe("cluster");
        cluster.Services.Order().ShouldBe(hub.Services.Append(R.Auction).Order());
        cluster.Infrastructure.Order().ShouldBe(hub.Infrastructure.Order());
    }
}
