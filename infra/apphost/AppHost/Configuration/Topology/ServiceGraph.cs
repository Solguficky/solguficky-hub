using System.Text;
using AppHost.Configuration.Models;

namespace AppHost.Configuration.Topology;

/// <summary>
/// Реестр узлов и их связей. Composition root объявляет граф, профиль решает,
/// какими узлами AppHost владеет, <see cref="Build"/> материализует только их.
/// У каждого узла два отображения: в локальный запуск и в чарт (ADR-055). Режим
/// выбирается здесь и только здесь — setup его не спрашивает.
/// </summary>
internal sealed class ServiceGraph(IDistributedApplicationBuilder builder, ProfileConfig profile)
{
    private readonly Dictionary<string, InfrastructureNode> _infrastructure =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly List<ServiceNode> _services = [];

    private Action<IDistributedApplicationBuilder>? _publishEnvironment;

    /// <summary>
    /// Backing store: контейнер или внешний ресурс, который поднимает Aspire.
    /// Материализуется, если профиль перечислил имя в <c>Infrastructure</c>.
    /// </summary>
    public ServiceGraph AddInfrastructure<T>(
        string name,
        Func<ServiceGraphContext, IResourceBuilder<T>> configure,
        PublishMapping publish)
        where T : IResource
    {
        _infrastructure[name] = new InfrastructureNode(context => configure(context), publish);
        return this;
    }

    /// <summary>
    /// Компонент платформы. <paramref name="depends"/> — единственный источник
    /// зависимостей: он задаёт порядок материализации и то, что setup вправе
    /// биндить. Собственные узлы сборки и кодогенерации сюда не попадают.
    /// </summary>
    public ServiceGraph AddService<T>(
        string name,
        string[] depends,
        Func<ServiceGraphContext, IResourceBuilder<T>> configure,
        PublishMapping publish)
        where T : IResource
    {
        _services.Add(new ServiceNode(name, depends, context => configure(context), publish));
        return this;
    }

    /// <summary>
    /// Среда, в которую публикуется чарт. Локальный запуск её не создаёт: граф
    /// <c>aspire run</c> от публикации не меняется.
    /// </summary>
    public ServiceGraph PublishTo(Action<IDistributedApplicationBuilder> environment)
    {
        _publishEnvironment = environment;
        return this;
    }

    public void Build()
    {
        var publishing = builder.ExecutionContext.IsPublishMode;
        Validate(publishing);

        var context = new ServiceGraphContext(builder, profile);

        if (publishing)
        {
            _publishEnvironment?.Invoke(builder);
        }

        var ownedInfrastructure = _infrastructure.Keys
            .Where(profile.OwnsInfrastructure)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();

        foreach (var name in ownedInfrastructure)
        {
            var node = _infrastructure[name];
            if (!publishing)
            {
                context.Set(name, node.Configure(context));
            }
            else if (node.Publish is PublishMapping.ConnectionsMapping connections)
            {
                connections.Publish(context);
            }
        }

        var ownedServices = SortByDependencies(
            _services.Where(node => profile.OwnsService(node.Name)).ToList());

        var workloads = new HashSet<IResource>();
        foreach (var node in ownedServices)
        {
            if (!publishing)
            {
                context.Set(node.Name, node.Configure(context));
            }
            else if (node.Publish is PublishMapping.WorkloadMapping workload)
            {
                var resource = workload.Configure(context);
                workloads.Add(resource.Resource);
                context.Set(node.Name, resource);
            }
        }

        if (publishing)
        {
            VerifyNoLeakedCompute(workloads);
        }

        PrintTopology(context, ownedInfrastructure, ownedServices);
    }

    /// <summary>
    /// Генератор публикует workload'ом каждый compute-ресурс модели, без opt-in.
    /// Поэтому узел сборки, который setup по ошибке завёл и в публикации, попал бы
    /// в чарт молча. Здесь он роняет сборку чарта с именем ресурса.
    /// </summary>
    private void VerifyNoLeakedCompute(HashSet<IResource> workloads)
    {
        foreach (var resource in builder.Resources
            .OfType<IComputeResource>()
            .Where(resource => !workloads.Contains(resource))
            .OrderBy(resource => resource.Name, StringComparer.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Resource '{resource.Name}' ({resource.GetType().Name}) would be published as a workload, " +
                "but no Workload publish mapping produced it. Build steps and local-only nodes must not exist in publish mode.");
        }
    }

    /// <summary>
    /// Опечатка в имени и зависимость на незарегистрированный узел падают на
    /// старте, а не превращаются в тихо неподключённый ресурс. Проверка
    /// двусторонняя: профиль не вправе назвать незарегистрированный узел, а
    /// зарегистрированный узел не вправе остаться без профиля — иначе он не
    /// материализуется ни в одном запуске, и заметить это нечем.
    /// </summary>
    private void Validate(bool publishing)
    {
        var registered = _infrastructure.Keys
            .Concat(_services.Select(node => node.Name))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var node in _services)
        {
            foreach (var dependency in node.Depends.Where(name => !registered.Contains(name)))
            {
                throw new InvalidOperationException(
                    $"Service '{node.Name}' depends on '{dependency}', which is not registered in the graph.");
            }
        }

        foreach (var name in profile.Services.Where(name => !registered.Contains(name)))
        {
            throw new InvalidOperationException(
                $"Profile '{profile.Name}' lists service '{name}', which is not registered in the graph.");
        }

        foreach (var name in profile.Infrastructure.Where(name => !_infrastructure.ContainsKey(name)))
        {
            throw new InvalidOperationException(
                $"Profile '{profile.Name}' lists infrastructure '{name}', which is not registered in the graph.");
        }

        // Обратная сторона: узел, которого нет ни в одном профиле, не поднимется
        // никогда. Отказ здесь стоит потому, что симптома у такого узла нет —
        // сборка зелёная, запуск успешный, а ресурса просто нет в дашборде.
        // Поэтому регистрация узла и появление его владельца обязаны ехать одним
        // изменением.
        var declared = ProfileResolver.DeclaredNames(builder.Configuration);

        foreach (var name in registered
            .Where(name => !declared.Contains(name))
            .Order(StringComparer.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Node '{name}' is registered in the graph, but no profile owns it, so it is never materialized. " +
                "List it in a profile under 'Topology:Profiles', or register it together with the change that brings its first consumer.");
        }

        ValidatePublishMappings(publishing);
    }

    /// <summary>
    /// Профиль публикации проверяется в обоих режимах: узел, который чарт получить
    /// не может, отвергается обычным прогоном тестов и <c>aspire run</c>, а не
    /// только сборкой чарта в CI.
    /// </summary>
    private void ValidatePublishMappings(bool publishing)
    {
        var published = publishing ? profile : ProfileResolver.PublishProfile(builder.Configuration);
        if (published is null)
        {
            return;
        }

        // Опечатка в профиле публикации не должна ждать сборки чарта в CI: в
        // локальном запуске этот профиль не активен, и общая проверка имён его
        // не видит.
        foreach (var name in published.Services.Where(name => _services.All(node =>
            !string.Equals(node.Name, name, StringComparison.OrdinalIgnoreCase))))
        {
            throw new InvalidOperationException(
                $"Publish profile '{published.Name}' lists service '{name}', which is not registered in the graph.");
        }

        foreach (var name in published.Infrastructure.Where(name => !_infrastructure.ContainsKey(name)))
        {
            throw new InvalidOperationException(
                $"Publish profile '{published.Name}' lists infrastructure '{name}', which is not registered in the graph.");
        }

        foreach (var (name, node) in _infrastructure
            .Where(pair => published.OwnsInfrastructure(pair.Key))
            .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            RequireMapping<PublishMapping.ConnectionsMapping>(published, name, node.Publish, "infrastructure", "Connections");
        }

        foreach (var node in _services
            .Where(node => published.OwnsService(node.Name))
            .OrderBy(node => node.Name, StringComparer.OrdinalIgnoreCase))
        {
            RequireMapping<PublishMapping.WorkloadMapping>(published, node.Name, node.Publish, "service", "Workload");
        }
    }

    private static void RequireMapping<TExpected>(
        ProfileConfig published,
        string name,
        PublishMapping mapping,
        string kind,
        string expected)
        where TExpected : PublishMapping
    {
        switch (mapping)
        {
            case TExpected:
                return;
            case PublishMapping.NotPublishedMapping excluded:
                throw new InvalidOperationException(
                    $"Publish profile '{published.Name}' owns {kind} '{name}', which is not published: {excluded.Reason}. " +
                    "Remove it from the publish profile or give it a publish mapping.");
            default:
                throw new InvalidOperationException(
                    $"Publish profile '{published.Name}' owns {kind} '{name}', whose publish mapping is " +
                    $"{mapping.GetType().Name}; {kind} nodes publish as {expected}.");
        }
    }

    private static List<ServiceNode> SortByDependencies(List<ServiceNode> owned)
    {
        var byName = owned.ToDictionary(node => node.Name, node => node, StringComparer.OrdinalIgnoreCase);
        var sorted = new List<ServiceNode>();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var node in owned)
        {
            Visit(node, byName, sorted, visited, visiting);
        }

        return sorted;
    }

    private static void Visit(
        ServiceNode node,
        Dictionary<string, ServiceNode> byName,
        List<ServiceNode> sorted,
        HashSet<string> visited,
        HashSet<string> visiting)
    {
        if (visited.Contains(node.Name))
        {
            return;
        }

        if (!visiting.Add(node.Name))
        {
            throw new InvalidOperationException($"Circular service dependency at '{node.Name}'.");
        }

        foreach (var dependency in node.Depends)
        {
            if (byName.TryGetValue(dependency, out var next))
            {
                Visit(next, byName, sorted, visited, visiting);
            }
        }

        visiting.Remove(node.Name);
        visited.Add(node.Name);
        sorted.Add(node);
    }

    /// <summary>
    /// Печатает то, что действительно материализовано, и объявленные
    /// зависимости, которых в этом запуске нет: их владелец запускает сам.
    /// </summary>
    private void PrintTopology(
        ServiceGraphContext context,
        List<string> ownedInfrastructure,
        List<ServiceNode> ownedServices)
    {
        var text = new StringBuilder();
        text.AppendLine();
        text.AppendLine($"========== AppHost topology: {profile.Name} ==========");

        text.AppendLine("  Infrastructure:");
        foreach (var name in ownedInfrastructure)
        {
            text.AppendLine($"    {name,-24} owned");
        }

        text.AppendLine("  Services:");
        foreach (var node in ownedServices)
        {
            text.AppendLine($"    {node.Name,-24} owned");
        }

        // Инфраструктура в публикации становится строками подключения под своими
        // именами, а сам узел в контексте не появляется, — но владелец у неё есть.
        var unowned = ownedServices
            .SelectMany(node => node.Depends.Select(dependency => (node.Name, dependency)))
            .Where(pair => !context.Has(pair.dependency)
                && !ownedInfrastructure.Contains(pair.dependency, StringComparer.OrdinalIgnoreCase))
            .ToList();

        if (unowned.Count > 0)
        {
            text.AppendLine("  Not owned by this profile (started by the owner):");
            foreach (var (service, dependency) in unowned)
            {
                text.AppendLine($"    {dependency,-24} needed by {service}");
            }
        }

        text.AppendLine("======================================================");
        Console.WriteLine(text.ToString());
    }

    private sealed record InfrastructureNode(
        Func<ServiceGraphContext, object> Configure,
        PublishMapping Publish);

    private sealed record ServiceNode(
        string Name,
        string[] Depends,
        Func<ServiceGraphContext, object> Configure,
        PublishMapping Publish);
}
