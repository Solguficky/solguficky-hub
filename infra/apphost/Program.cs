using AppHost.Configuration;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;

using R = AppHost.Configuration.AppHostNames.Resources;

var builder = DistributedApplication.CreateBuilder(args);
var profile = ProfileResolver.Resolve(builder.Configuration);
var topology = new ServiceGraph(builder, profile);

topology.AddInfrastructure(R.Postgres, PostgresSetup.Configure);
topology.AddInfrastructure(R.Nats, NatsSetup.Configure);
topology.AddInfrastructure(R.Loki, LokiSetup.Configure);
topology.AddInfrastructure(R.Grafana, GrafanaSetup.Configure);

topology.AddService(R.Identity, [R.Postgres], IdentitySetup.Configure);
topology.AddService(R.Meetups, [R.Postgres, R.Nats], MeetupsSetup.Configure);
topology.AddService(R.Notifications, [R.Postgres, R.Nats, R.Loki], NotificationsSetup.Configure);
topology.AddService(R.TelegramBot, [R.Identity, R.Meetups, R.Notifications], TelegramBotSetup.Configure);

topology.Build();
builder.Build().Run();
