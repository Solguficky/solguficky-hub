namespace AuctionService.Handlers;

using Akka.Actor;
using Akka.Hosting;
using AuctionService.Actors;
using AuctionService.Actors.Auction;
using AuctionService.Actors.Lot;
using AuctionService.Services;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using NATS.Client;
using Nats.Commands;
using System;
using System.Threading;
using System.Threading.Tasks;

public class NatsCommandHandler : IHostedService
{
    private readonly IConnection _natsConnection;
    private readonly IActorRef _registry;
    private readonly LotRepository _lotRepository;
    private readonly ILogger<NatsCommandHandler> _logger;
    private IAsyncSubscription? _placeBidSubscription;
    private IAsyncSubscription? _setProxyBidSubscription;
    private IAsyncSubscription? _startAuctionSubscription;
    private IAsyncSubscription? _transitionToFinalSubscription;

    public NatsCommandHandler(
        IConfiguration configuration,
        IRequiredActor<AuctionRegistry> registryActor,
        LotRepository lotRepository,
        ILogger<NatsCommandHandler> logger)
    {
        var natsUrl = configuration["Nats:Url"] ?? throw new InvalidOperationException("Nats:Url is not configured.");
        _natsConnection = new ConnectionFactory().CreateConnection(natsUrl);
        _registry = registryActor.ActorRef;
        _lotRepository = lotRepository;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Starting NATS command handler...");

        _placeBidSubscription = _natsConnection.SubscribeAsync("commands.auction.place_bid", (sender, args) =>
        {
            try
            {
                var command = PlaceBidCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received PlaceBidCommand for Lot {LotId} in auction {AuctionId}",
                    command.LotId, command.AuctionId);

                var placeBid = new PlaceBid(command.UserId, command.Amount);
                var forwardCommand = new ForwardToLot(command.AuctionId, (int)command.LotId, placeBid);

                _registry.Tell(forwardCommand);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process PlaceBidCommand.");
            }
        });

        _setProxyBidSubscription = _natsConnection.SubscribeAsync("commands.auction.set_proxy_bid", (sender, args) =>
        {
            try
            {
                var command = SetProxyBidCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received SetProxyBidCommand for Lot {LotId} in auction {AuctionId}",
                    command.LotId, command.AuctionId);

                var setProxyBid = new SetProxyBid(command.UserId, command.MaxAmount);
                var forwardCommand = new ForwardToLot(command.AuctionId, (int)command.LotId, setProxyBid);

                _registry.Tell(forwardCommand);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process SetProxyBidCommand.");
            }
        });

        _startAuctionSubscription = _natsConnection.SubscribeAsync("commands.auction.start", async (sender, args) =>
        {
            try
            {
                var command = StartAuctionCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received StartAuctionCommand for Auction {AuctionId}", command.AuctionId);

                var lots = await _lotRepository.GetLotsByAuctionId(command.AuctionId);
                if (lots.Count == 0)
                {
                    _logger.LogWarning("No lots found for auction {AuctionId}", command.AuctionId);
                    return;
                }

                var lotIds = lots.Select(l => l.Id).ToList();
                var lotConfigs = lots.ToDictionary(
                    l => l.Id,
                    l => new LotConfig(l.StartingPrice, l.MinBidStep)
                );

                var startAuction = new StartAuction(command.AuctionId, lotIds, lotConfigs);
                var forwardCommand = new ForwardToAuction(command.AuctionId, startAuction);

                _registry.Tell(forwardCommand);
                _logger.LogInformation("Started auction {AuctionId} with {LotCount} lots",
                    command.AuctionId, lots.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process StartAuctionCommand.");
            }
        });

        _transitionToFinalSubscription = _natsConnection.SubscribeAsync("commands.auction.transition_to_final", (sender, args) =>
        {
            try
            {
                var command = TransitionToFinalPhaseCommand.Parser.ParseFrom(args.Message.Data);
                _logger.LogInformation("Received TransitionToFinalPhaseCommand for Auction {AuctionId}", command.AuctionId);

                var transitionCommand = new TransitionToFinalPhase();
                var forwardCommand = new ForwardToAuction(command.AuctionId, transitionCommand);

                _registry.Tell(forwardCommand);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process TransitionToFinalPhaseCommand.");
            }
        });

        _logger.LogInformation("NATS command handler started.");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Stopping NATS command handler...");
        _placeBidSubscription?.Unsubscribe();
        _setProxyBidSubscription?.Unsubscribe();
        _startAuctionSubscription?.Unsubscribe();
        _transitionToFinalSubscription?.Unsubscribe();
        _natsConnection.Close();
        _logger.LogInformation("NATS command handler stopped.");
        return Task.CompletedTask;
    }
}

