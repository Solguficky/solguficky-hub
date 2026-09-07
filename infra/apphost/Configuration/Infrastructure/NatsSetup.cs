using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class NatsSetup
{
    public static IResourceBuilder<NatsServerResource> Configure(ServiceGraphContext context) =>
        context.Builder
            .AddNats(AppHostNames.Resources.Nats)
            .WithImageTag("2.10-alpine")
            .WithJetStream();
}
