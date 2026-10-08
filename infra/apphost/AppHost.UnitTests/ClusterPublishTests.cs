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
    private static async Task<IDistributedApplicationTestingBuilder> PublishModelAsync(params string[] extra)
    {
        var output = Path.Combine(Path.GetTempPath(), $"apphost-publish-{Guid.NewGuid():N}");
        return await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(
            ["--operation", "publish", "--publisher", "default", "--output-path", output, .. extra],
            TestContext.Current.CancellationToken);
    }

    /// <summary>
    /// Кроме сервисов в модели один compute-ресурс — Job топологии JetStream,
    /// которым владеет публикация NATS (PER-311).
    /// </summary>
    [Fact]
    public async Task Publish_Workloads_AreTheHubWithAuctionAndTopologyJob()
    {
        var builder = await PublishModelAsync();

        builder.ExecutionContext.IsPublishMode.ShouldBeTrue();
        builder.Resources.OfType<IComputeResource>()
            .Select(resource => resource.Name)
            .Order(StringComparer.Ordinal)
            .ShouldBe([R.Auction, R.AuctionBot, R.HubBot, R.Identity, NatsSetup.TopologyJobName, R.Meetups, R.Notifications]);
    }

    /// <summary>
    /// Значений токенов при публикации нет — CI собирает чарт без секретов, —
    /// поэтому ветка публикации бота аукциона проверку своего токена не зовёт:
    /// повтор токена бота хаба ловит выкладка среды до старта подов. Иначе чарт
    /// не собрался бы без токенов, а с одинаковыми — тем более.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("same")]
    public async Task Publish_AuctionBot_DoesNotCheckTokenValues(string token)
    {
        var builder = await PublishModelAsync(
            $"--Parameters:auction-bot-token={token}",
            $"--Parameters:hub-bot-token={token}");

        builder.Resources.ShouldContain(resource => resource.Name == R.AuctionBot);
    }

    /// <summary>
    /// Identity, боты и Auction собираются по своим Containerfile из корня
    /// репозитория, а не цепочкой buf/go build, sbt и голой JVM и не контейнером,
    /// который Aspire сгенерировал бы из <c>AddJavaScriptApp</c>: их кодогенерации
    /// нужен <c>contracts/proto</c>.
    /// </summary>
    [Theory]
    [InlineData(R.Identity, "apps/identity/Containerfile")]
    [InlineData(R.HubBot, "apps/hub-bot/Containerfile")]
    [InlineData(R.AuctionBot, "apps/hub-bot/Containerfile")]
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

    /// <summary>
    /// Без дашборда Aspire не выдаёт сервису в чарте ни адреса OTLP, ни имени:
    /// экспорт в поде молча выключается (PER-378). Адрес — Collector своей среды,
    /// одинаковый во всех средах. Бот аукциона OTLP не шлёт, его логи Collector
    /// читает из файлов подов, и адрес задвоил бы их, когда экспорт у бота появится.
    /// </summary>
    [Theory]
    [InlineData(R.Identity)]
    [InlineData(R.Meetups)]
    [InlineData(R.Notifications)]
    [InlineData(R.HubBot)]
    [InlineData(R.Auction)]
    public async Task Publish_OtlpServices_ExportToTheCollectorOfTheirEnvironment(string name)
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, name);

        environment["OTEL_EXPORTER_OTLP_ENDPOINT"].ShouldBe("http://otel-collector:4317");
        environment["OTEL_EXPORTER_OTLP_PROTOCOL"].ShouldBe("grpc");
        environment["OTEL_SERVICE_NAME"].ShouldBe(name);
    }

    [Fact]
    public async Task Publish_AuctionBot_HasNoOtlpEndpoint()
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, R.AuctionBot);

        environment.Keys.ShouldNotContain(key => key.StartsWith("OTEL_EXPORTER_OTLP", StringComparison.Ordinal));
    }

    private static async Task<Dictionary<string, object>> PublishEnvironmentAsync(
        IDistributedApplicationTestingBuilder builder,
        string name)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var resource = builder.Resources.Single(resource => resource.Name == name);
        var environment = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(new EnvironmentCallbackContext(builder.ExecutionContext, resource, environment, cancellationToken));
        }

        return environment;
    }

    [Fact]
    public async Task Publish_KubernetesEnvironment_HasNoDashboard()
    {
        var builder = await PublishModelAsync();

        var environment = builder.Resources.OfType<KubernetesEnvironmentResource>().ShouldHaveSingleItem();
        environment.DashboardEnabled.ShouldBeFalse();
    }

    /// <summary>
    /// Чарт собирается из <c>cluster</c>, а локальный стенд хаба с аукционом — из
    /// <c>hub-auction</c>. Расхождение составов — решение, которое должно быть
    /// видно правкой этого теста, а не тихо приехать в прод вместе с изменением
    /// локального профиля. Stage поднимает хаб с аукционом и оба бота
    /// (дополнения к ADR-055); локальный <c>hub</c> JVM не тянет.
    /// </summary>
    [Fact]
    public void PublishProfile_MatchesHubAuctionComposition()
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .Build();

        var cluster = ProfileResolver.PublishProfile(configuration).ShouldNotBeNull();
        var local = ProfileResolver.Resolve(new ConfigurationBuilder()
            .AddConfiguration(configuration)
            .AddInMemoryCollection([new("profile", "hub-auction")])
            .Build());

        cluster.Name.ShouldBe("cluster");
        cluster.Services.Order().ShouldBe(local.Services.Order());
        cluster.Infrastructure.Order().ShouldBe(local.Infrastructure.Order());
    }
}
