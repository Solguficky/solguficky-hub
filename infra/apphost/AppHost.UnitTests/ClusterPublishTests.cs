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
    /// Кроме сервисов в модели — Job топологии JetStream, которым владеет
    /// публикация NATS (PER-311), и туннель публичного входа (ADR-071).
    /// </summary>
    [Fact]
    public async Task Publish_Workloads_AreTheHubWithAuctionTopologyJobAndTunnel()
    {
        var builder = await PublishModelAsync();

        builder.ExecutionContext.IsPublishMode.ShouldBeTrue();
        builder.Resources.OfType<IComputeResource>()
            .Select(resource => resource.Name)
            .Order(StringComparer.Ordinal)
            .ShouldBe([R.Auction, R.AuctionBot, R.Cloudflared, R.HubBot, R.Identity, NatsSetup.TopologyJobName, R.Meetups, R.Notifications, R.SupportBot]);
    }

    /// <summary>
    /// Значений токенов при публикации нет — CI собирает чарт без секретов, —
    /// поэтому ветки публикации ботов аукциона и поддержки проверку своего
    /// токена не зовут: повтор ловит выкладка среды до старта подов. Иначе чарт
    /// не собрался бы без токенов, а с одинаковыми — тем более.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("same")]
    public async Task Publish_Bots_DoNotCheckTokenValues(string token)
    {
        var builder = await PublishModelAsync(
            $"--Parameters:auction-bot-token={token}",
            $"--Parameters:support-bot-token={token}",
            $"--Parameters:hub-bot-token={token}");

        builder.Resources.ShouldContain(resource => resource.Name == R.AuctionBot);
        builder.Resources.ShouldContain(resource => resource.Name == R.SupportBot);
    }

    /// <summary>
    /// Identity, бот хаба и Auction собираются по своим Containerfile из корня
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

    /// <summary>
    /// Боты аукциона и поддержки своей сборки не имеют: образ у пакета ботов
    /// один (ADR-064, п. 18). Сборка дала бы боту свой ключ образа в values, и
    /// среда могла бы выкатить ботам разный код под одним Containerfile. Что
    /// workload читает ключ бота хаба, держит правило чарта
    /// (tools/apphost/check-chart.py).
    /// </summary>
    [Theory]
    [InlineData(R.AuctionBot)]
    [InlineData(R.SupportBot)]
    public async Task Publish_SurfaceBot_HasNoBuildOfItsOwn(string name)
    {
        var builder = await PublishModelAsync();

        var resource = builder.Resources.Single(resource => resource.Name == name);

        resource.ShouldBeOfType<ContainerResource>();
        resource.Annotations.OfType<DockerfileBuildAnnotation>().ShouldBeEmpty();
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
    /// одинаковый во всех средах. Боты аукциона и поддержки OTLP не шлют, их
    /// логи Collector читает из файлов подов, и адрес задвоил бы их, когда экспорт у бота появится.
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

    [Theory]
    [InlineData(R.AuctionBot)]
    [InlineData(R.SupportBot)]
    public async Task Publish_SurfaceBot_HasNoOtlpEndpoint(string name)
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, name);

        environment.Keys.ShouldNotContain(key => key.StartsWith("OTEL_EXPORTER_OTLP", StringComparison.Ordinal));
    }

    /// <summary>
    /// Умолчание категории «Новое в боте» в чарте — «выключено» (ADR-069, п. 5):
    /// values прода без ключа оставляют сводки выключенными, а не будят людей,
    /// и stage включает их своим значением. Снимок графа значения не показывает,
    /// поэтому его держит этот тест.
    /// </summary>
    [Fact]
    public async Task Publish_ReleaseNotesDefault_IsOffUnlessValuesSayOtherwise()
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, R.Notifications);

        var parameter = (ParameterResource)environment["NOTIFICATIONS_RELEASE_NOTES_ENABLED_BY_DEFAULT"];
        parameter.Name.ShouldBe("notifications-release-notes-enabled-by-default");
        parameter.Secret.ShouldBeFalse();
        (await parameter.GetValueAsync(TestContext.Current.CancellationToken)).ShouldBe("false");
    }

    /// <summary>
    /// Итог розыгрыша в чарте — жеребьёвка по маяку (ADR-066, дополнение
    /// 2026-10-24): values среды без ключа оставляют прежнее поведение, а ручной
    /// итог включают своим значением. Снимок графа значения не показывает,
    /// поэтому его держит этот тест.
    /// </summary>
    [Fact]
    public async Task Publish_RaffleDraw_IsAutomaticUnlessValuesSayOtherwise()
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, R.Auction);

        var parameter = (ParameterResource)environment["AUCTION_RAFFLE_DRAW"];
        parameter.Name.ShouldBe("auction-raffle-draw");
        parameter.Secret.ShouldBeFalse();
        (await parameter.GetValueAsync(TestContext.Current.CancellationToken)).ShouldBe("automatic");
    }

    /// <summary>
    /// Очередь сообщества в чарте открыта (дополнение ADR-060 от 2026-10-25,
    /// PER-739): values среды без ключа оставляют прежнее поведение, а вход
    /// только по белому списку включают значением <c>closed</c>. Снимок графа
    /// значения не показывает, поэтому его держит этот тест.
    /// </summary>
    [Fact]
    public async Task Publish_CommunityQueue_IsOpenUnlessValuesSayOtherwise()
    {
        var builder = await PublishModelAsync();

        var environment = await PublishEnvironmentAsync(builder, R.Identity);

        var parameter = (ParameterResource)environment["IDENTITY_COMMUNITY_QUEUE"];
        parameter.Name.ShouldBe("identity-community-queue");
        parameter.Secret.ShouldBeFalse();
        (await parameter.GetValueAsync(TestContext.Current.CancellationToken)).ShouldBe("open");
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
    /// локального профиля. Stage поднимает хаб с аукционом и три бота
    /// (дополнения к ADR-055); локальный <c>hub</c> JVM не тянет. Единственное
    /// расхождение — туннель публичного входа: локально экран открывается по
    /// адресу, который публикует Aspire (ADR-071).
    /// </summary>
    [Fact]
    public void PublishProfile_IsHubAuctionCompositionWithTunnel()
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
        cluster.Services.Order().ShouldBe(local.Services.Append(R.Cloudflared).Order());
        cluster.Infrastructure.Order().ShouldBe(local.Infrastructure.Order());
    }
}
