namespace AuctionService.Handlers;

using Akka.Actor;
using Akka.Hosting;
using AuctionService.Actors;
using AuctionService.Actors.Auction;
using AuctionService.Actors.Lot;
using AuctionService.Constants;
using AuctionService.Services;
using Google.Protobuf;
using Microsoft.Extensions.Hosting;
using NATS.Client;
using Nats.Commands;

public class NatsCommandHandler : BackgroundService
{
    private readonly IConnection _natsConnection;
    private readonly IActorRef _registry;
    private readonly LotRepository _lotRepository;
    private readonly ILogger<NatsCommandHandler> _logger;
    private readonly List<IAsyncSubscription> _subscriptions = new();

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

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Starting NATS command handler...");

        SubscribeCommand<PlaceBidCommand>(NatsSubjects.Commands.PlaceBid, command =>
        {
            var auctionId = Ulid.Parse(command.AuctionId);
            _logger.LogInformation("Received PlaceBidCommand for Lot {LotId} in auction {AuctionId}",
                command.LotId, auctionId);

            var placeBid = new PlaceBid(command.UserId, command.Amount);
            var forwardCommand = new Actors.ForwardToLot(auctionId, (int)command.LotId, placeBid);
            _registry.Tell(forwardCommand);
        });

        SubscribeCommand<SetProxyBidCommand>(NatsSubjects.Commands.SetProxyBid, command =>
        {
            var auctionId = Ulid.Parse(command.AuctionId);
            _logger.LogInformation("Received SetProxyBidCommand for Lot {LotId} in auction {AuctionId}",
                command.LotId, auctionId);

            var setProxyBid = new SetProxyBid(command.UserId, command.MaxAmount);
            var forwardCommand = new Actors.ForwardToLot(auctionId, (int)command.LotId, setProxyBid);
            _registry.Tell(forwardCommand);
        });

        SubscribeCommandAsync<StartAuctionCommand>(NatsSubjects.Commands.StartAuction, async command =>
        {
            var auctionId = Ulid.Parse(command.AuctionId);
            _logger.LogInformation("Received StartAuctionCommand for Auction {AuctionId}", auctionId);

            var lots = await _lotRepository.GetLotsByAuctionId(command.AuctionId);
            if (lots.Count == 0)
            {
                _logger.LogWarning("No lots found for auction {AuctionId}", auctionId);
                return;
            }

            var lotIds = lots.Select(l => l.Id).ToList();
            var lotConfigs = lots.ToDictionary(
                l => l.Id,
                l => new LotConfig(l.StartingPrice, l.MinBidStep)
            );

            var startAuction = new StartAuction(auctionId, lotIds, lotConfigs);
            var forwardCommand = new ForwardToAuction(auctionId, startAuction);

            _registry.Tell(forwardCommand);
            _logger.LogInformation("Started auction {AuctionId} with {LotCount} lots",
                auctionId, lots.Count);
        });

        SubscribeCommand<EndOpenBiddingCommand>(NatsSubjects.Commands.EndOpenBidding, command =>
        {
            var auctionId = Ulid.Parse(command.AuctionId);
            _logger.LogInformation("Received EndOpenBiddingCommand for Auction {AuctionId}", auctionId);

            var endOpenBiddingCmd = new EndOpenBidding();
            var forwardCommand = new ForwardToAuction(auctionId, endOpenBiddingCmd);
            _registry.Tell(forwardCommand);
        });

        SubscribeCommand<StartFinalPhaseCommand>(NatsSubjects.Commands.StartFinalPhase, command =>
        {
            var auctionId = Ulid.Parse(command.AuctionId);
            _logger.LogInformation("Received StartFinalPhaseCommand for Auction {AuctionId}", auctionId);

            var startFinalPhaseCmd = new StartFinalPhase();
            var forwardCommand = new ForwardToAuction(auctionId, startFinalPhaseCmd);
            _registry.Tell(forwardCommand);
        });

        _logger.LogInformation("NATS command handler started.");
        return Task.CompletedTask;
    }

    private void SubscribeCommand<TCommand>(string subject, Action<TCommand> handler)
        where TCommand : IMessage<TCommand>, new()
    {
        var parser = new MessageParser<TCommand>(() => new TCommand());
        var subscription = _natsConnection.SubscribeAsync(subject, (sender, args) =>
        {
            try
            {
                var command = parser.ParseFrom(args.Message.Data);
                handler(command);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process command from subject {Subject}", subject);
            }
        });

        _subscriptions.Add(subscription);
    }

    private void SubscribeCommandAsync<TCommand>(string subject, Func<TCommand, Task> handler)
        where TCommand : IMessage<TCommand>, new()
    {
        var parser = new MessageParser<TCommand>(() => new TCommand());
        var subscription = _natsConnection.SubscribeAsync(subject, async (sender, args) =>
        {
            try
            {
                var command = parser.ParseFrom(args.Message.Data);
                await handler(command);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process async command from subject {Subject}", subject);
            }
        });

        _subscriptions.Add(subscription);
    }

    public override void Dispose()
    {
        _logger.LogInformation("Disposing NATS command handler...");
        foreach (var subscription in _subscriptions)
        {
            subscription?.Unsubscribe();
        }
        _natsConnection.Close();
        _logger.LogInformation("NATS command handler disposed.");
        base.Dispose();
    }
}
