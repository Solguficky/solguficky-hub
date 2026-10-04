using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;

using P = AppHost.Configuration.Topology.PublishMapping;
using R = AppHost.Configuration.AppHostNames.Resources;

namespace AppHost.Configuration;

/// <summary>
/// Единое описание графа для запуска AppHost и снимка его построенной модели.
/// Конфигурация не запускает приложение: Build и Run остаются вызывающей стороне.
/// </summary>
internal static class AppHostTopology
{
    public static void Configure(IDistributedApplicationBuilder builder)
    {
        var profile = ProfileResolver.Resolve(builder.Configuration, builder.ExecutionContext);
        var topology = new ServiceGraph(builder, profile);

        topology.PublishTo(ClusterEnvironment.Configure);

        var localLogStack = P.NotPublished("local log stack; production telemetry goes through the Collector (ADR-053)");

        topology.AddInfrastructure(R.Postgres, PostgresSetup.Configure, P.Connections(PostgresSetup.Publish));
        topology.AddInfrastructure(R.Nats, NatsSetup.Configure, P.Connections(NatsSetup.Publish));
        topology.AddInfrastructure(R.Loki, LokiSetup.Configure, localLogStack);
        topology.AddInfrastructure(R.Grafana, GrafanaSetup.Configure, localLogStack);

        topology.AddService(R.Identity, [R.Postgres, R.Nats], IdentitySetup.Configure, P.Workload(IdentitySetup.Publish));
        topology.AddService(R.Meetups, [R.Postgres, R.Nats, R.Identity], MeetupsSetup.Configure, P.Workload(MeetupsSetup.Publish));
        topology.AddService(R.Notifications, [R.Postgres, R.Nats, R.Loki, R.Identity, R.Meetups], NotificationsSetup.Configure, P.Workload(NotificationsSetup.Publish));
        topology.AddService(R.HubBot, [R.Nats, R.Identity, R.Meetups, R.Notifications], HubBotSetup.Configure, P.Workload(HubBotSetup.Publish));
        topology.AddService(R.Auction, [R.Postgres, R.Nats, R.Meetups], AuctionSetup.Configure, P.Workload(AuctionSetup.Publish));
        topology.AddService(R.AuctionBot, [R.Nats, R.Identity, R.Auction], AuctionBotSetup.Configure, P.NotPublished("outside the MVP (ADR-055)"));

        topology.Build();
    }
}
