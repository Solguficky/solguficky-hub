using AppHost.Configuration.Models;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Валидация и материализация графа отрабатывают до старта ресурсов, поэтому
/// проверяются на L0: Docker, DCP и дашборд здесь не нужны.
/// </summary>
public class ServiceGraphTests
{
    private const string Postgres = "postgres";
    private const string Nats = "nats";
    private const string Identity = "identity";
    private const string TelegramBot = "telegram-bot";

    private static IDistributedApplicationBuilder Builder(params (string Key, string Value)[] profiles)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        var values = profiles.Length > 0
            ? profiles.ToDictionary(pair => pair.Key, pair => (string?)pair.Value)
            : new Dictionary<string, string?>
            {
                ["Topology:Profiles:hub:Services:0"] = Identity,
                ["Topology:Profiles:hub:Infrastructure:0"] = Postgres,
                ["Topology:Profiles:hub:Infrastructure:1"] = Nats,
            };

        // Ссылка на AppHost кладёт его настоящий appsettings.json в выходной
        // каталог теста, и CreateBuilder читает его из content root. Без очистки
        // источников профили прогона накладываются поверх продовых, а не заменяют
        // их: узел, который тест оставил без владельца, всё равно оказывается
        // назван реальным профилем, и ветка отказа не срабатывает. Тест обязан
        // видеть ровно ту топологию, которую сам объявил.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(values);
        return builder;
    }

    private static ProfileConfig Profile(string name, string[] services, string[] infrastructure) =>
        new() { Name = name, Services = [.. services], Infrastructure = [.. infrastructure] };

    // Материализация любым дешёвым ресурсом: граф проверяет владение и порядок,
    // а не то, какой именно образ стоит за узлом.
    private static IResourceBuilder<ContainerResource> Node(ServiceGraphContext context, string name) =>
        context.Builder.AddContainer(name, "busybox");

    /// <summary>
    /// Ветка отказа, ради которой набор и заведён: у такого узла нет симптома —
    /// сборка зелёная, запуск успешный, ресурса просто нет.
    /// </summary>
    [Fact]
    public void Build_RegisteredNodeHasNoOwningProfile_ThrowsNamingTheNode()
    {
        var builder = Builder(
            ("Topology:Profiles:hub:Services:0", Identity),
            ("Topology:Profiles:hub:Infrastructure:0", Postgres));

        var graph = new ServiceGraph(builder, Profile("hub", [Identity], [Postgres]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));
        graph.AddInfrastructure(Nats, context => Node(context, Nats));
        graph.AddService(Identity, [Postgres], context => Node(context, Identity));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain(Nats);
        exception.Message.ShouldContain("no profile owns it");
    }

    [Fact]
    public void Build_EveryRegisteredNodeIsOwnedBySomeProfile_DoesNotThrow()
    {
        var builder = Builder();

        var graph = new ServiceGraph(builder, Profile("hub", [Identity], [Postgres, Nats]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));
        graph.AddInfrastructure(Nats, context => Node(context, Nats));
        graph.AddService(Identity, [Postgres], context => Node(context, Identity));

        Should.NotThrow(graph.Build);
    }

    /// <summary>
    /// Узел назван одним профилем, а поднимает его другой: владелец есть, значит
    /// инвариант молчит. Иначе он запрещал бы профиль одного сервиса.
    /// </summary>
    [Fact]
    public void Build_NodeOwnedByAnotherProfile_DoesNotThrowForActiveProfile()
    {
        var builder = Builder(
            ("Topology:Profiles:infra:Infrastructure:0", Nats),
            ("Topology:Profiles:identity:Services:0", Identity),
            ("Topology:Profiles:identity:Infrastructure:0", Postgres));

        var graph = new ServiceGraph(builder, Profile("identity", [Identity], [Postgres]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));
        graph.AddInfrastructure(Nats, context => Node(context, Nats));
        graph.AddService(Identity, [Postgres], context => Node(context, Identity));

        Should.NotThrow(graph.Build);
    }

    [Fact]
    public void Build_ProfileListsUnregisteredService_ThrowsNamingTheProfile()
    {
        var builder = Builder(
            ("Topology:Profiles:hub:Services:0", TelegramBot),
            ("Topology:Profiles:hub:Infrastructure:0", Postgres));

        var graph = new ServiceGraph(builder, Profile("hub", [TelegramBot], [Postgres]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain(TelegramBot);
        exception.Message.ShouldContain("not registered in the graph");
    }

    [Fact]
    public void Build_ServiceDependsOnUnregisteredNode_ThrowsNamingTheDependency()
    {
        var builder = Builder(
            ("Topology:Profiles:hub:Services:0", Identity),
            ("Topology:Profiles:hub:Infrastructure:0", Postgres));

        var graph = new ServiceGraph(builder, Profile("hub", [Identity], [Postgres]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));
        graph.AddService(Identity, [Nats], context => Node(context, Identity));

        var exception = Should.Throw<InvalidOperationException>(graph.Build);

        exception.Message.ShouldContain(Nats);
    }

    /// <summary>
    /// Профиль решает, а не реестр: узел, которого нет в профиле, в запуск не
    /// попадает, даже когда он зарегистрирован и назван чужим профилем.
    /// </summary>
    [Fact]
    public void Build_ProfileOwnsSubsetOfGraph_MaterializesOnlyOwnedNodes()
    {
        var builder = Builder(
            ("Topology:Profiles:infra:Infrastructure:0", Nats),
            ("Topology:Profiles:identity:Services:0", Identity),
            ("Topology:Profiles:identity:Infrastructure:0", Postgres));

        var graph = new ServiceGraph(builder, Profile("identity", [Identity], [Postgres]));
        graph.AddInfrastructure(Postgres, context => Node(context, Postgres));
        graph.AddInfrastructure(Nats, context => Node(context, Nats));
        graph.AddService(Identity, [Postgres], context => Node(context, Identity));

        graph.Build();

        var materialized = builder.Resources.Select(resource => resource.Name).ToList();
        materialized.ShouldContain(Postgres);
        materialized.ShouldContain(Identity);
        materialized.ShouldNotContain(Nats);
    }
}
