using AppHost.Configuration;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;

using P = AppHost.Configuration.Topology.PublishMapping;
using R = AppHost.Configuration.AppHostNames.Resources;

var builder = DistributedApplication.CreateBuilder(args);
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
topology.AddService(R.TelegramBot, [R.Nats, R.Identity, R.Meetups, R.Notifications], TelegramBotSetup.Configure, P.Workload(TelegramBotSetup.Publish));
topology.AddService(R.Auction, [R.Postgres], AuctionSetup.Configure, P.NotPublished("outside the MVP (ADR-055)"));
topology.AddService(R.AuctionBot, [R.Identity, R.Auction], AuctionBotSetup.Configure, P.NotPublished("outside the MVP (ADR-055)"));

topology.Build();
builder.Build().Run();
