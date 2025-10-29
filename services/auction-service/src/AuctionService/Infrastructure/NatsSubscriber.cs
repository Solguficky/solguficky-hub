namespace AuctionService.Infrastructure;

using Akka.Actor;
using AuctionService.Application.Services;
using AuctionService.Domain.Lot;
using AuctionService.Domain.Registry;
using AuctionService.Domain.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using NATS.Client;
using Nats.Commands;
using System;
using System.Threading;
using System.Threading.Tasks;

public class NatsSubscriber : IHostedService
{
    private readonly IConnection _natsConnection;
    private readonly IActorRef _registry;
    private readonly LotCrudService _lotCrudService;
    private readonly ILogger<NatsSubscriber> _logger;
    private IAsyncSubscription? _placeBidSubscription;
    private IAsyncSubscription? _startAuctionSubscription;

    public NatsSubscriber(
        IConfiguration configuration,
        IActorRef registry,
        LotCrudService lotCrudService,
        ILogger<NatsSubscriber> logger)
    {
        var natsUrl = configuration["Nats:Url"] ?? throw new InvalidOperationException("Nats:Url is not configured.");
        _natsConnection = new ConnectionFactory().CreateConnection(natsUrl);
        _registry = registry;
        _lotCrudService = lotCrudService;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Starting NATS subscriber...");

        _placeBidSubscription = _natsConnection.SubscribeAsync("commands.auction.place_bid", (sender, args) =>
        {
            try
            {
                var command = PlaceBidCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received PlaceBidCommand for Lot {LotId}", command.LotId);

                var placeBid = new PlaceBid(command.UserId, command.Amount);
                var routeCommand = new RouteLotCommand(command.EventId, (int)command.LotId, placeBid);

                _registry.Tell(routeCommand);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process PlaceBidCommand.");
            }
        });

        _startAuctionSubscription = _natsConnection.SubscribeAsync("commands.auction.start", async (sender, args) =>
        {
            try
            {
                var command = StartAuctionCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received StartAuctionCommand for Event {EventId}", command.EventId);

                var lots = await _lotCrudService.GetLotsByEventId(command.EventId);
                if (lots.Count == 0)
                {
                    _logger.LogWarning("No lots found for event {EventId}", command.EventId);
                    return;
                }

                var lotIds = lots.Select(l => l.Id).ToList();
                var lotConfigs = lots.ToDictionary(
                    l => l.Id,
                    l => new LotConfig(l.StartingPrice, l.MinBidStep)
                );

                var startAuction = new StartAuction(command.EventId, lotIds, lotConfigs);
                var routeCommand = new RouteSessionCommand(command.EventId, startAuction);

                _registry.Tell(routeCommand);
                _logger.LogInformation("Started auction for event {EventId} with {LotCount} lots", command.EventId, lots.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process StartAuctionCommand.");
            }
        });

        _logger.LogInformation("NATS subscriber started.");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Stopping NATS subscriber...");
        _placeBidSubscription?.Unsubscribe();
        _startAuctionSubscription?.Unsubscribe();
        _natsConnection.Close();
        _logger.LogInformation("NATS subscriber stopped.");
        return Task.CompletedTask;
    }
}
