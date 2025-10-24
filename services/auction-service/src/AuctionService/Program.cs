using Akka.Actor;
using Akka.Hosting;
using Akka.Persistence.Hosting;
using Akka.Persistence.PostgreSql.Hosting;
using AuctionService.Application.GrpcServices;
using AuctionService.Application.Services;
using AuctionService.Domain.Registry;
using AuctionService.Infrastructure;
using AuctionService.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Serilog;
using Serilog.Events;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .CreateLogger();

builder.Host.UseSerilog();

var postgresConnectionString = builder.Configuration["Akka:Persistence:ConnectionString"]
    ?? throw new InvalidOperationException("Akka:Persistence:ConnectionString is not configured");

builder.Services.AddDbContext<AuctionDbContext>(options =>
    options.UseNpgsql(postgresConnectionString));

builder.Services.AddScoped<LotCrudService>();
builder.Services.AddSingleton<INatsPublisher, NatsPublisher>();

builder.Services.AddAkka("auction-service", (configBuilder, serviceProvider) =>
{
    configBuilder
        .ConfigureLoggers(setup =>
        {
            setup.LogLevel = Akka.Event.LogLevel.InfoLevel;
            setup.AddLogger<Akka.Logger.Serilog.SerilogLogger>();
        })
        .WithActors((system, registry, resolver) =>
        {
            var registryActor = system.ActorOf(Props.Create(() => new AuctionRegistryActor()), "auction-registry");
            registry.Register<AuctionRegistryActor>(registryActor);

            var natsPublisher = resolver.GetRequiredService<INatsPublisher>();
            var eventListener = system.ActorOf(
                Props.Create(() => new NatsEventListener(natsPublisher)),
                "nats-event-listener"
            );
        })
        .WithPostgreSqlPersistence(
            connectionString: postgresConnectionString,
            autoInitialize: true,
            storedAs: Akka.Persistence.PostgreSql.StoredAsType.ByteA
        )
        .WithPostgreSqlReadJournal()
        .WithEventAdapter<AuctionEventTagger>(
            "auction-event-tagger",
            boundTypes: new[]
            {
                typeof(Domain.Lot.BidPlaced),
                typeof(Domain.Lot.ProxyBidSet),
                typeof(Domain.Lot.LotTimerExtended),
                typeof(Domain.Lot.AuctionFinished),
                typeof(Domain.Lot.LotSold),
                typeof(Domain.Session.AuctionStarted),
                typeof(Domain.Session.OpenBiddingStarted),
                typeof(Domain.Session.AuctionFinished)
            }
        );
});

builder.Services.AddSingleton(provider =>
{
    var actorRegistry = provider.GetRequiredService<ActorRegistry>();
    return actorRegistry.Get<AuctionRegistryActor>();
});

builder.Services.AddHostedService<NatsSubscriber>();

builder.Services.AddGrpc();
builder.Services.AddSingleton<AuctionGrpcService>();
builder.Services.AddSingleton<LotGrpcService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AuctionDbContext>();
    await dbContext.Database.MigrateAsync();
    Log.Information("Database migrations applied");
}

app.MapGrpcService<AuctionGrpcService>();

app.MapGet("/health", () => Results.Ok(new { status = "healthy", service = "auction-service" }));

app.Lifetime.ApplicationStopping.Register(() =>
{
    Log.Information("Shutting down Akka.NET ActorSystem...");
});

Log.Information("Auction Service started");

app.Run();
