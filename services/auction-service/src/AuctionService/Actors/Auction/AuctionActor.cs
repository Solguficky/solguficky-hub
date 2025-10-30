namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;
using Akka.Actor;
using Akka.Event;
using Akka.Persistence;
using AuctionService.Actors.Lot;

public class AuctionActor : ReceivePersistentActor
{
    public override string PersistenceId { get; }
    private State _state = State.Empty();
    private readonly ILoggingAdapter _log = Context.GetLogger();
    private readonly Dictionary<int, LotConfig> _lotConfigs = new();

    public AuctionActor(string auctionId)
    {
        PersistenceId = $"auction-{auctionId}";

        Command<StartAuction>(HandleStartAuction);
        Command<RouteToLot>(HandleRouteToLot);
        Command<TransitionToFinalPhase>(HandleTransitionToFinalPhase);
        Command<FinishAuction>(HandleFinishAuction);
        Command<GetAuctionStatus>(HandleGetAuctionStatus);

        Recover<AuctionStarted>(ApplyAuctionStarted);
        Recover<OpenBiddingStarted>(ApplyOpenBiddingStarted);
        Recover<FinalPhaseStarted>(ApplyFinalPhaseStarted);
        Recover<AuctionFinished>(ApplyAuctionFinished);
    }

    private void HandleStartAuction(StartAuction cmd)
    {
        if (_state.Phase != AuctionPhase.NotStarted)
        {
            _log.Warning("Auction {AuctionId} already started", cmd.AuctionId);
            Sender.Tell(new StatusMessage("Auction already started"), Self);
            return;
        }

        _log.Info("Starting auction {AuctionId} with {LotCount} lots", cmd.AuctionId, cmd.LotIds.Count);

        foreach (var (lotId, config) in cmd.LotConfigs)
        {
            _lotConfigs[lotId] = config;
        }

        var startedEvt = new AuctionStarted(cmd.AuctionId, cmd.LotIds, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(startedEvt, e =>
        {
            ApplyAuctionStarted(e);

            var openBiddingEvt = new OpenBiddingStarted(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            Persist(openBiddingEvt, openEvt =>
            {
                ApplyOpenBiddingStarted(openEvt);
                CreateLotActors();
                Sender.Tell(new StatusMessage("Auction started"), Self);
            });
        });
    }

    private void CreateLotActors()
    {
        foreach (var lotId in _state.LotIds)
        {
            if (!_lotConfigs.TryGetValue(lotId, out var config))
            {
                _log.Warning("No config found for lot {LotId}, skipping", lotId);
                continue;
            }

            var lotActor = Context.ActorOf(
                Props.Create(() => new LotActor(lotId, config.StartingPrice, config.MinBidStep)),
                $"lot-{lotId}"
            );

            _log.Info("Created LotActor for lot {LotId}", lotId);
        }
    }

    private void HandleRouteToLot(RouteToLot cmd)
    {
        if (_state.Phase == AuctionPhase.NotStarted || _state.Phase == AuctionPhase.Finished)
        {
            _log.Warning("Auction {AuctionId} is not active", _state.AuctionId);
            Sender.Tell(new StatusMessage("Auction is not active"), Self);
            return;
        }

        _log.Debug("Routing command to Lot-{LotId}", cmd.LotId);

        var lotActor = Context.Child($"lot-{cmd.LotId}");
        if (lotActor.IsNobody())
        {
            _log.Warning("Lot actor {LotId} not found", cmd.LotId);
            Sender.Tell(new StatusMessage($"Lot {cmd.LotId} not found"), Self);
            return;
        }

        lotActor.Forward(cmd.Command);
    }

    private void HandleTransitionToFinalPhase(TransitionToFinalPhase cmd)
    {
        if (_state.Phase != AuctionPhase.OpenBidding)
        {
            _log.Warning("Cannot transition to Final phase. Current phase: {Phase}", _state.Phase);
            Sender.Tell(new StatusMessage($"Cannot transition from {_state.Phase} to Final"), Self);
            return;
        }

        _log.Info("Transitioning auction {AuctionId} to Final phase", _state.AuctionId);

        var evt = new FinalPhaseStarted(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyFinalPhaseStarted(e);
            Sender.Tell(new StatusMessage("Transitioned to Final phase"), Self);
        });
    }

    private void HandleFinishAuction(FinishAuction cmd)
    {
        if (_state.Phase == AuctionPhase.Finished)
        {
            _log.Warning("Auction {AuctionId} already finished", _state.AuctionId);
            Sender.Tell(new StatusMessage("Auction already finished"), Self);
            return;
        }

        _log.Info("Finishing auction {AuctionId}", _state.AuctionId);

        var evt = new AuctionFinished(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyAuctionFinished(e);
            Sender.Tell(new StatusMessage("Auction finished"), Self);
        });
    }

    private void HandleGetAuctionStatus(GetAuctionStatus cmd)
    {
        Sender.Tell(new AuctionStatusResponse(
            _state.AuctionId,
            _state.Phase,
            _state.LotIds
        ), Self);
    }

    private void ApplyAuctionStarted(AuctionStarted evt)
    {
        _log.Info("Applied AuctionStarted for auction {AuctionId}", evt.AuctionId);
        _state = _state with
        {
            AuctionId = evt.AuctionId,
            LotIds = evt.LotIds.ToImmutableList()
        };
    }

    private void ApplyOpenBiddingStarted(OpenBiddingStarted evt)
    {
        _log.Info("Applied OpenBiddingStarted");
        _state = _state with { Phase = AuctionPhase.OpenBidding };
    }

    private void ApplyFinalPhaseStarted(FinalPhaseStarted evt)
    {
        _log.Info("Applied FinalPhaseStarted");
        _state = _state with { Phase = AuctionPhase.Final };
    }

    private void ApplyAuctionFinished(AuctionFinished evt)
    {
        _log.Info("Applied AuctionFinished");
        _state = _state with { Phase = AuctionPhase.Finished };
    }
}

public sealed record StatusMessage(string Message);

