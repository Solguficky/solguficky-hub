using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class LokiSetup
{
    public static IResourceBuilder<ContainerResource> Configure(ServiceGraphContext context) =>
        context.Builder
            .AddContainer(AppHostNames.Resources.Loki, "grafana/loki", "3.7.0")
            .WithBindMount(
                Path.Combine(RepositoryPaths.Root(context.Builder), "infra", "observability", "loki-config.yml"),
                "/etc/loki/local-config.yaml",
                isReadOnly: true)
            .WithArgs("-config.file=/etc/loki/local-config.yaml")
            .WithHttpEndpoint(targetPort: 3100, name: AppHostNames.Endpoints.Http)
            .WithHttpHealthCheck("/ready");
}
