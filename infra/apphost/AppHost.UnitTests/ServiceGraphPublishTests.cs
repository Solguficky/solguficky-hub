using AppHost.Configuration;
using AppHost.Configuration.Models;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Ветка публикации графа (ADR-055). Узел, который не попадает в чарт, обязан
/// ронять сборку графа с именем, а не выпадать из чарта молча: чарт без сервиса
/// проходит и <c>helm lint</c>, и <c>helm template</c>, и заметили бы его только
/// на кластере.
/// </summary>
public class ServiceGraphPublishTests
{
    private const string Postgres = "postgres";
    private const string Identity = "identity";
    private const string IdentityDb = "identity-db";

    private const string Reason = "kept out of the chart by this test";

    private static IDistributedApplicationBuilder Builder(bool publish, params (string Key, string Value)[] settings)
    {
        string[] args = publish
            ? ["--operation", "publish", "--publisher", "default", "--output-path", Path.GetTempPath()]
            : [];
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = args, DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests: режим уже выбран аргументами
        // при создании builder, а топологию тест объявляет сам.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            settings.ToDictionary(pair => pair.Key, pair => (string?)pair.Value));
        return builder;
    }

    private static readonly (string, string)[] ClusterOwnsIdentity =
    [
        ("Topology:PublishProfile", "cluster"),
        ("Topology:Profiles:cluster:Services:0", Identity),
        ("Topology:Profiles:cluster:Infrastructure:0", Postgres),
    ];

    private static ProfileConfig Cluster() =>
        new() { Name = "cluster", Services = [Identity], Infrastructure = [Postgres] };

    private static IResourceBuilder<ContainerResource> Workload(ServiceGraphContext context) =>
        context.Builder.AddContainer(Identity, "busybox");

    private static IResourceBuilder<ContainerResource> NeverLocally(ServiceGraphContext context) =>
        throw new InvalidOperationException("The local mapping must not run in publish mode.");

    private static void PublishDatabase(ServiceGraphContext context) =>
        context.Publish(IdentityDb, context.Builder.AddConnectionString(IdentityDb));

    /// <summary>
    /// Негативный путь задачи: профиль публикации владеет узлом, у которого нет
    /// отображения в чарт. Отказ приходит уже локальным прогоном — тестом и
    /// <c>aspire run</c>, — а не только сборкой чарта в CI.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Build_PublishProfileOwnsUnpublishedService_ThrowsNamingNodeAndReason(bool publish)
    {
        var builder = Builder(publish, ClusterOwnsIdentity);
        var graph = new ServiceGraph(builder, Cluster());
        graph.AddInfrastructure(Postgres, NeverLocally, PublishMapping.Connections(PublishDatabase));
        graph.AddService(Identity, [Postgres], Workload, PublishMapping.NotPublished(Reason));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain($"'{Identity}'");
        exception.Message.ShouldContain(Reason);
    }

    [Fact]
    public void Build_PublishProfileOwnsInfrastructureMappedAsWorkload_Throws()
    {
        var builder = Builder(publish: false, ClusterOwnsIdentity);
        var graph = new ServiceGraph(builder, Cluster());
        graph.AddInfrastructure(Postgres, NeverLocally, PublishMapping.Workload(Workload));
        graph.AddService(Identity, [Postgres], Workload, PublishMapping.Workload(Workload));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain($"'{Postgres}'");
        exception.Message.ShouldContain("Connections");
    }

    /// <summary>
    /// Генератор публикует каждый compute-ресурс модели. Узел сборки, заведённый
    /// в публикации по ошибке, стал бы workload'ом чарта — граф называет его.
    /// </summary>
    [Fact]
    public void Build_PublishMappingLeaksBuildStep_ThrowsNamingTheLeakedResource()
    {
        var builder = Builder(publish: true, ClusterOwnsIdentity);
        var graph = new ServiceGraph(builder, Cluster());
        graph.AddInfrastructure(Postgres, NeverLocally, PublishMapping.Connections(PublishDatabase));
        graph.AddService(Identity, [Postgres], Workload, PublishMapping.Workload(context =>
        {
            context.Builder.AddExecutable("identity-build", "go", ".", "build");
            return Workload(context);
        }));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain("'identity-build'");
    }

    [Fact]
    public void Build_PublishMode_MaterializesPublishMappingsOnly()
    {
        var builder = Builder(publish: true, ClusterOwnsIdentity);
        var graph = new ServiceGraph(builder, Cluster());
        graph.AddInfrastructure(Postgres, NeverLocally, PublishMapping.Connections(PublishDatabase));
        graph.AddService(Identity, [Postgres], NeverLocally, PublishMapping.Workload(Workload));

        graph.Build();

        builder.Resources.OfType<IResourceWithConnectionString>().Select(resource => resource.Name).ShouldBe([IdentityDb]);
        builder.Resources.OfType<IComputeResource>().Select(resource => resource.Name).ShouldBe([Identity]);
    }

    /// <summary>
    /// Срез запуска чарту не принадлежит: чарт с частью сервисов выглядел бы
    /// полным. Флаг отвергается явно, а не игнорируется.
    /// </summary>
    [Theory]
    [InlineData("profile", "hub")]
    [InlineData("run-services", Identity)]
    [InlineData("skip-services", Identity)]
    public void ResolvePublish_RunSliceFlag_Throws(string key, string value)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(ClusterOwnsIdentity
                .Select(pair => new KeyValuePair<string, string?>(pair.Item1, pair.Item2))
                .Append(new(key, value)))
            .Build();

        var exception = Should.Throw<InvalidOperationException>(() => ProfileResolver.ResolvePublish(configuration));

        exception.Message.ShouldContain($"--{key}");
    }

    [Fact]
    public void ResolvePublish_PublishProfileNotSet_Throws()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection([new("Topology:Profiles:cluster:Services:0", Identity)])
            .Build();

        var exception = Should.Throw<InvalidOperationException>(() => ProfileResolver.ResolvePublish(configuration));

        exception.Message.ShouldContain("Topology:PublishProfile");
    }
}
