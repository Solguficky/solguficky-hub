using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class GrafanaSetup
{
    public static IResourceBuilder<ContainerResource> Configure(ServiceGraphContext context)
    {
        var observability = Path.Combine(RepositoryPaths.Root(context.Builder), "infra", "observability");

        return context.Builder
            .AddContainer(AppHostNames.Resources.Grafana, "grafana/grafana", "13.1.6")
            .WithBindMount(
                Path.Combine(observability, "grafana-datasources.yml"),
                "/etc/grafana/provisioning/datasources/loki.yml",
                isReadOnly: true)
            .WithBindMount(
                Path.Combine(observability, "grafana-dashboards.yml"),
                "/etc/grafana/provisioning/dashboards/reminders.yml",
                isReadOnly: true)
            .WithBindMount(
                Path.Combine(observability, "reminders-dashboard.json"),
                "/var/lib/grafana/dashboards/reminders.json",
                isReadOnly: true)
            .WithHttpEndpoint(targetPort: 3000, name: AppHostNames.Endpoints.Http)
            .WithHttpHealthCheck("/api/health");
    }
}
