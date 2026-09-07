using System.Text;
using AppHost.Configuration.Models;

namespace AppHost.Configuration.Topology;

/// <summary>
/// Реестр узлов и их связей. Composition root объявляет граф, профиль решает,
/// какими узлами AppHost владеет, <see cref="Build"/> материализует только их.
/// </summary>
internal sealed class ServiceGraph(IDistributedApplicationBuilder builder, ProfileConfig profile)
{
    private readonly Dictionary<string, Func<ServiceGraphContext, object>> _infrastructure =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly List<ServiceNode> _services = [];

    /// <summary>
    /// Backing store: контейнер или внешний ресурс, который поднимает Aspire.
    /// Материализуется, если профиль перечислил имя в <c>Infrastructure</c>.
    /// </summary>
    public ServiceGraph AddInfrastructure<T>(
        string name,
        Func<ServiceGraphContext, IResourceBuilder<T>> configure)
        where T : IResource
    {
        _infrastructure[name] = context => configure(context);
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
        Func<ServiceGraphContext, IResourceBuilder<T>> configure)
        where T : IResource
    {
        _services.Add(new ServiceNode(name, depends, context => configure(context)));
        return this;
    }

    public void Build()
    {
        Validate();

        var context = new ServiceGraphContext(builder, profile);

        var ownedInfrastructure = _infrastructure.Keys
            .Where(profile.OwnsInfrastructure)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();

        foreach (var name in ownedInfrastructure)
        {
            context.Set(name, _infrastructure[name](context));
        }

        var ownedServices = SortByDependencies(
            _services.Where(node => profile.OwnsService(node.Name)).ToList());

        foreach (var node in ownedServices)
        {
            context.Set(node.Name, node.Configure(context));
        }

        PrintTopology(context, ownedInfrastructure, ownedServices);
    }

    /// <summary>
    /// Опечатка в имени и зависимость на незарегистрированный узел падают на
    /// старте, а не превращаются в тихо неподключённый ресурс.
    /// </summary>
    private void Validate()
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

        var unowned = ownedServices
            .SelectMany(node => node.Depends.Select(dependency => (node.Name, dependency)))
            .Where(pair => !context.Has(pair.dependency))
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

    private sealed record ServiceNode(
        string Name,
        string[] Depends,
        Func<ServiceGraphContext, object> Configure);
}
