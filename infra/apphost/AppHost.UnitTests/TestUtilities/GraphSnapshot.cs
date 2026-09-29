using System.Text;
using System.Text.RegularExpressions;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace AppHost.UnitTests.TestUtilities;

/// <summary>
/// Текстовый снимок модели настоящего AppHost: тот же Program.cs, что исполняет
/// <c>aspire run</c>, доведённый до сборки модели без старта ресурсов. Снимок
/// держит то, чем узел становится для запуска, — тип, образ, команду, endpoints,
/// переменные окружения с их выражениями, ожидания и связи, — поэтому изменение
/// графа видно строкой диффа, а не только живым прогоном.
/// </summary>
internal static partial class GraphSnapshot
{
    public static async Task<string> RenderAsync(string[] args, CancellationToken cancellationToken)
    {
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(args, cancellationToken);
        var root = Normalize(Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../../..")), root: null);

        await using var application = await builder.BuildAsync(cancellationToken);
        var executionContext = application.Services.GetRequiredService<DistributedApplicationExecutionContext>();
        var model = application.Services.GetRequiredService<DistributedApplicationModel>();

        var text = new StringBuilder();
        foreach (var resource in model.Resources.OrderBy(resource => resource.Name, StringComparer.Ordinal))
        {
            text.AppendLine($"{resource.Name}: {resource.GetType().Name}");
            await RenderResourceAsync(text, resource, executionContext, root, cancellationToken);
        }

        return text.ToString();
    }

    private static async Task RenderResourceAsync(
        StringBuilder text,
        IResource resource,
        DistributedApplicationExecutionContext executionContext,
        string root,
        CancellationToken cancellationToken)
    {
        if (resource is ParameterResource parameter)
        {
            text.AppendLine($"  secret: {parameter.Secret}");
        }

        foreach (var image in resource.Annotations.OfType<ContainerImageAnnotation>())
        {
            text.AppendLine($"  image: {image.Registry}/{image.Image}:{image.Tag}");
        }

        foreach (var build in resource.Annotations.OfType<DockerfileBuildAnnotation>())
        {
            text.AppendLine($"  build: {Normalize(build.DockerfilePath, root)} context={Normalize(build.ContextPath, root)}");
        }

        if (resource is ExecutableResource executable)
        {
            text.AppendLine($"  command: {Normalize(executable.Command, root)}");
            text.AppendLine($"  workdir: {Normalize(executable.WorkingDirectory, root)}");
        }

        var args = new List<object>();
        foreach (var callback in resource.Annotations.OfType<CommandLineArgsCallbackAnnotation>())
        {
            await callback.Callback(new CommandLineArgsCallbackContext(args, resource, cancellationToken)
            {
                ExecutionContext = executionContext,
            });
        }

        foreach (var arg in args)
        {
            text.AppendLine($"  arg: {Normalize(Render(arg), root)}");
        }

        foreach (var endpoint in resource.Annotations.OfType<EndpointAnnotation>().OrderBy(e => e.Name, StringComparer.Ordinal))
        {
            text.AppendLine(
                $"  endpoint: {endpoint.Name} {endpoint.UriScheme} port={endpoint.Port} target={endpoint.TargetPort} " +
                $"proxied={endpoint.IsProxied} external={endpoint.IsExternal}");
        }

        var environment = new Dictionary<string, object>();
        foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(new EnvironmentCallbackContext(executionContext, resource, environment, cancellationToken));
        }

        foreach (var (key, value) in environment.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            // Адрес дашборда и ключи OTLP выдаёт среда прогона, а не граф: в
            // снимке остаётся только факт, что сервис экспортирует телеметрию.
            var rendered = key.StartsWith("OTEL_", StringComparison.Ordinal) || key.StartsWith("ASPIRE_DASHBOARD", StringComparison.Ordinal)
                ? "<run environment>"
                : Normalize(Render(value), root);
            text.AppendLine($"  env: {key}={rendered}");
        }

        foreach (var mount in resource.Annotations.OfType<ContainerMountAnnotation>())
        {
            text.AppendLine($"  mount: {mount.Type} {VolumeHash().Replace(mount.Source ?? string.Empty, "solguficky-<tree>-$1")} -> {mount.Target}");
        }

        foreach (var wait in resource.Annotations.OfType<WaitAnnotation>().OrderBy(w => w.Resource.Name, StringComparer.Ordinal))
        {
            text.AppendLine($"  waits: {wait.Resource.Name} {wait.WaitType}");
        }

        // Порядок связей повторяет порядок вызовов в setup и смысла не несёт:
        // перестановка WithEnvironment и WaitFor не меняет запуск.
        foreach (var relationship in resource.Annotations.OfType<ResourceRelationshipAnnotation>()
            .Select(relationship => $"{relationship.Type} {relationship.Resource.Name}")
            .Distinct()
            .Order(StringComparer.Ordinal))
        {
            text.AppendLine($"  relationship: {relationship}");
        }

        foreach (var health in resource.Annotations.OfType<HealthCheckAnnotation>().OrderBy(h => h.Key, StringComparer.Ordinal))
        {
            text.AppendLine($"  health: {health.Key}");
        }
    }

    private static string Render(object? value) => value switch
    {
        null => "<null>",
        string literal => literal,
        IManifestExpressionProvider expression => expression.ValueExpression,
        _ => value.ToString() ?? string.Empty,
    };

    // Каталог рабочего дерева и разделитель пути — свойства машины, а не графа.
    private static string Normalize(string value, string? root)
    {
        var normalized = value.Replace('\\', '/');
        if (root is null)
        {
            return normalized;
        }

        normalized = normalized.Replace(root, "<repo>", StringComparison.OrdinalIgnoreCase);
        return normalized.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? normalized[..^4] : normalized;
    }

    // Имя тома несёт хэш пути дерева (DataVolumes): одинаковое назначение в
    // двух деревьях даёт разные строки, а снимок о дереве не спрашивает.
    [GeneratedRegex("^solguficky-.+-[0-9a-f]{8}-([a-z-]+)$")]
    private static partial Regex VolumeHash();
}
