using Akka.Actor;
using Akka.Configuration;
using Akka.Hosting;
using Akka.Persistence.Sql.Hosting;
using AuctionService.Actors;
using AuctionService.Handlers;
using AuctionService.Infrastructure;
using AuctionService.Infrastructure.Persistence;
using AuctionService.Services;
using LinqToDB;
using Microsoft.EntityFrameworkCore;
using Serilog;
using Serilog.Events;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();

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

builder.Services.AddScoped<LotRepository>();
builder.Services.AddSingleton<INatsPublisher, NatsPublisher>();

var eventAdapterConfig = ConfigurationFactory.ParseString(@"
    akka.persistence.journal.sql {
        event-adapters {
            auction-tagger = ""AuctionService.Infrastructure.AuctionEventTagger, AuctionService""
        }
        event-adapter-bindings {
            ""AuctionService.Actors.Lot.BidPlaced, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Lot.ProxyBidSet, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Lot.AuctionFinished, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Lot.LotSold, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.AuctionStarted, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.OpenBiddingStarted, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.OpenBiddingEnded, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.FinalPhaseStarted, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.FinalPhaseEnded, AuctionService"" = auction-tagger
            ""AuctionService.Actors.Auction.AuctionFinished, AuctionService"" = auction-tagger
        }
    }
");

builder.Services.AddAkka("auction-service", (configBuilder, serviceProvider) =>
{
    configBuilder
        .AddHocon(eventAdapterConfig, HoconAddMode.Append)
        .ConfigureLoggers(setup =>
        {
            setup.LogLevel = Akka.Event.LogLevel.InfoLevel;
            setup.AddLogger<Akka.Logger.Serilog.SerilogLogger>();
        })
        .WithSqlPersistence(
            connectionString: postgresConnectionString,
            providerName: ProviderName.PostgreSQL15,
            autoInitialize: true)
        .WithActors((system, registry) =>
        {
            var auctionRegistry = system.ActorOf(Props.Create<AuctionRegistry>(), "auction-registry");
            registry.Register<AuctionRegistry>(auctionRegistry);

            var natsPublisher = serviceProvider.GetRequiredService<INatsPublisher>();
            var eventListener = system.ActorOf(
                Props.Create(() => new AkkaPersistenceQueryListener(natsPublisher)),
                "akka-persistence-query-listener"
            );
        });
});

builder.Services.AddHostedService<NatsCommandHandler>();

builder.Services.AddGrpc();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AuctionDbContext>();
    await dbContext.Database.MigrateAsync();
    Log.Information("Database migrations applied");
}

app.MapDefaultEndpoints();

app.MapGrpcService<AuctionGrpcService>();

app.Lifetime.ApplicationStopping.Register(() =>
{
    Log.Information("Shutting down Akka.NET ActorSystem...");
});

Log.Information("Auction Service started");

app.Run();
