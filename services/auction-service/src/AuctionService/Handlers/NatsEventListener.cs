namespace AuctionService.Handlers;

using Akka.Actor;
using Akka.Event;
using Akka.Persistence.Query;
using Akka.Persistence.Sql.Query;
using Akka.Streams;
using Akka.Streams.Dsl;
using AuctionService.Actors.Lot;
using AuctionService.Actors.Auction;
using AuctionService.Infrastructure;
using Nats.Events;
using System.Text.RegularExpressions;

public class NatsEventListener : ReceiveActor
{
    private readonly INatsPublisher _natsPublisher;
    private readonly ILoggingAdapter _log = Context.GetLogger();
    private readonly ActorMaterializer _materializer;
    private readonly SqlReadJournal _readJournal;
    private string _currentAuctionId = string.Empty;
    private readonly Regex _lotPersistenceIdRegex = new Regex(@"^lot-(\d+)$");

    public NatsEventListener(INatsPublisher natsPublisher)
    {
        _natsPublisher = natsPublisher;
        _materializer = Context.Materializer();

        _readJournal = PersistenceQuery
            .Get(Context.System)
            .ReadJournalFor<SqlReadJournal>("akka.persistence.query.journal.sql");

        SubscribeToEventStream();

        Receive<EventEnvelope>(HandleEventEnvelope);
    }

    private void SubscribeToEventStream()
    {
        var self = Self;
        _readJournal.EventsByTag("auction", Offset.NoOffset())
            .RunForeach(envelope => self.Tell(envelope), _materializer);

        _log.Info("Subscribed to Akka.Persistence.Query event stream with tag 'auction'");
    }

    private void HandleEventEnvelope(EventEnvelope envelope)
    {
        _log.Debug("Received event: {EventType} from {PersistenceId} at sequence {SequenceNr}",
            envelope.Event.GetType().Name, envelope.PersistenceId, envelope.SequenceNr);

        switch (envelope.Event)
        {
            case BidPlaced evt:
                HandleBidPlaced(evt, envelope.PersistenceId);
                break;
            case AuctionStarted evt:
                HandleAuctionStarted(evt);
                break;
            case OpenBiddingStarted evt:
                _log.Info("OpenBidding phase started for auction {AuctionId}", _currentAuctionId);
                break;
            case FinalPhaseStarted evt:
                HandleFinalPhaseStarted(evt);
                break;
            case Actors.Auction.AuctionFinished evt:
                HandleAuctionFinished(evt);
                break;
            case LotTimerExtended evt:
                _log.Debug("Lot timer extended to {NewEndTime}", evt.NewEndTime);
                break;
            case ProxyBidSet evt:
                _log.Debug("Proxy bid set for user {UserId}: {MaxAmount}", evt.UserId, evt.MaxAmount);
                break;
            default:
                _log.Debug("Unhandled event type: {EventType}", envelope.Event.GetType().Name);
                break;
        }
    }

    private void HandleBidPlaced(BidPlaced evt, string persistenceId)
    {
        var match = _lotPersistenceIdRegex.Match(persistenceId);
        if (!match.Success)
        {
            _log.Warning("Cannot extract lot ID from persistence ID: {PersistenceId}", persistenceId);
            return;
        }

        var lotId = int.Parse(match.Groups[1].Value);

        _log.Info("Publishing BidPlaced event for lot {LotId}, user {UserId}, amount {Amount}",
            lotId, evt.UserId, evt.Amount);

        var bidPlacedEvent = new BidPlacedEvent
        {
            AuctionId = _currentAuctionId,
            LotId = (uint)lotId,
            UserId = evt.UserId,
            Amount = evt.Amount,
            CurrentLeaderId = evt.UserId,
            PreviousLeaderId = evt.PreviousLeaderId ?? 0,
            LotTitle = string.Empty,
            PreviousAmount = 0
        };

        _natsPublisher.Publish("events.auction.bid_placed", bidPlacedEvent);
    }

    private void HandleAuctionStarted(AuctionStarted evt)
    {
        _log.Info("Auction started {AuctionId} with {LotCount} lots",
            evt.AuctionId, evt.LotIds.Count);
        _currentAuctionId = evt.AuctionId;

        var auctionStartedEvent = new AuctionStartedEvent
        {
            AuctionId = evt.AuctionId,
            LotIds = { evt.LotIds.Select(id => (uint)id) }
        };

        _natsPublisher.Publish("events.auction.started", auctionStartedEvent);
    }

    private void HandleFinalPhaseStarted(FinalPhaseStarted evt)
    {
        _log.Info("Final phase started for auction {AuctionId}", _currentAuctionId);

        var phaseTransitionedEvent = new PhaseTransitionedEvent
        {
            AuctionId = _currentAuctionId,
            FromPhase = "OpenBidding",
            ToPhase = "Final"
        };

        _natsPublisher.Publish("events.auction.phase_transitioned", phaseTransitionedEvent);
    }

    private void HandleAuctionFinished(Actors.Auction.AuctionFinished evt)
    {
        _log.Info("Auction finished {AuctionId}", _currentAuctionId);

        var phaseTransitionedEvent = new PhaseTransitionedEvent
        {
            AuctionId = _currentAuctionId,
            FromPhase = "Final",
            ToPhase = "Finished"
        };

        _natsPublisher.Publish("events.auction.phase_transitioned", phaseTransitionedEvent);
    }

    protected override void PostStop()
    {
        _materializer.Dispose();
        base.PostStop();
    }
}

