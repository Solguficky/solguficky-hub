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
    private readonly Dictionary<int, LotConfig> _lotConfigs = [];

    public AuctionActor(Guid auctionId)
    {
        PersistenceId = $"auction-{auctionId}";

        Command<StartAuction>(HandleStartAuction);
        Command<ForwardToLot>(HandleForwardToLot);
        Command<EndOpenBidding>(HandleEndOpenBidding);
        Command<StartFinalPhase>(HandleStartFinalPhase);
        Command<FinishAuction>(HandleFinishAuction);
        Command<GetAuctionStatus>(HandleGetAuctionStatus);

        Recover<AuctionStarted>(ApplyAuctionStarted);
        Recover<OpenBiddingStarted>(ApplyOpenBiddingStarted);
        Recover<OpenBiddingEnded>(ApplyOpenBiddingEnded);
        Recover<FinalPhaseStarted>(ApplyFinalPhaseStarted);
        Recover<FinalPhaseEnded>(ApplyFinalPhaseEnded);
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
        foreach (var (lotId, _) in _state.Lots)
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

    private void HandleForwardToLot(ForwardToLot cmd)
    {
        if (_state.Phase == AuctionPhase.NotStarted || _state.Phase == AuctionPhase.Finished)
        {
            _log.Warning("Auction {AuctionId} is not active", _state.AuctionId);
            Sender.Tell(new StatusMessage("Auction is not active"), Self);
            return;
        }

        _log.Debug("Forwarding command to Lot-{LotId} in auction {AuctionId}", cmd.LotId, _state.AuctionId);

        var lotActor = Context.Child($"lot-{cmd.LotId}");
        if (lotActor.IsNobody())
        {
            _log.Warning("Lot actor {LotId} not found in auction {AuctionId}", cmd.LotId, _state.AuctionId);
            Sender.Tell(new StatusMessage($"Lot {cmd.LotId} not found"), Self);
            return;
        }

        lotActor.Forward(cmd.LotCommand);
    }

    private void HandleEndOpenBidding(EndOpenBidding cmd)
    {
        if (_state.Phase != AuctionPhase.OpenBidding)
        {
            _log.Warning("Cannot end OpenBidding phase. Current phase: {Phase} for auction {AuctionId}",
                _state.Phase, _state.AuctionId);
            Sender.Tell(new StatusMessage($"Cannot end OpenBidding from {_state.Phase}"), Self);
            return;
        }

        _log.Info("Ending OpenBidding phase for auction {AuctionId}", _state.AuctionId);

        var evt = new OpenBiddingEnded(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyOpenBiddingEnded(e);
            Sender.Tell(new StatusMessage("OpenBidding phase ended"), Self);
        });
    }

    private void HandleStartFinalPhase(StartFinalPhase cmd)
    {
        if (_state.Phase != AuctionPhase.Idle)
        {
            _log.Warning("Cannot start Final phase. Current phase: {Phase} for auction {AuctionId}",
                _state.Phase, _state.AuctionId);
            Sender.Tell(new StatusMessage($"Cannot start Final phase from {_state.Phase}"), Self);
            return;
        }

        _log.Info("Starting Final phase for auction {AuctionId}", _state.AuctionId);

        var evt = new FinalPhaseStarted(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyFinalPhaseStarted(e);
            Sender.Tell(new StatusMessage("Final phase started"), Self);
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
            _state.Lots.Select(l => l.LotId).ToImmutableList()
        ), Self);
    }

    private void ApplyAuctionStarted(AuctionStarted evt)
    {
        _log.Info("Applied AuctionStarted for auction {AuctionId}", evt.AuctionId);
        var lots = evt.LotIds.Select((lotId, index) => (lotId, DisplayOrder: index)).ToImmutableList();
        _state = _state with
        {
            AuctionId = evt.AuctionId,
            Lots = lots
        };
    }

    private void ApplyOpenBiddingStarted(OpenBiddingStarted evt)
    {
        _log.Info("Applied OpenBiddingStarted for auction {AuctionId}", _state.AuctionId);
        _state = _state with { Phase = AuctionPhase.OpenBidding };
    }

    private void ApplyOpenBiddingEnded(OpenBiddingEnded evt)
    {
        _log.Info("Applied OpenBiddingEnded for auction {AuctionId}", _state.AuctionId);
        _state = _state with { Phase = AuctionPhase.Idle };
    }

    private void ApplyFinalPhaseStarted(FinalPhaseStarted evt)
    {
        _log.Info("Applied FinalPhaseStarted for auction {AuctionId}", _state.AuctionId);
        _state = _state with { Phase = AuctionPhase.Final };
    }

    private void ApplyFinalPhaseEnded(FinalPhaseEnded evt)
    {
        _log.Info("Applied FinalPhaseEnded for auction {AuctionId}", _state.AuctionId);
        _state = _state with { Phase = AuctionPhase.Finished };
    }

    private void ApplyAuctionFinished(AuctionFinished evt)
    {
        _log.Info("Applied AuctionFinished for auction {AuctionId}", _state.AuctionId);
        _state = _state with { Phase = AuctionPhase.Finished };
    }
}

public sealed record StatusMessage(string Message);

