namespace AuctionService.Infrastructure;

using Akka.Actor;
using Akka.Event;
using Akka.Persistence.Query;
using Akka.Persistence.Query.Sql;
using Akka.Streams;
using Akka.Streams.Dsl;
using AuctionService.Domain.Lot;
using AuctionService.Domain.Session;
using Nats.Events;
using System.Text.RegularExpressions;

public class NatsEventListener : ReceiveActor
{
    private readonly INatsPublisher _natsPublisher;
    private readonly ILoggingAdapter _log = Context.GetLogger();
    private readonly ActorMaterializer _materializer;
    private readonly SqlReadJournal _readJournal;
    private string _currentEventId = string.Empty;
    private readonly Regex _lotPersistenceIdRegex = new Regex(@"^lot-(\d+)$");

    public NatsEventListener(INatsPublisher natsPublisher)
    {
        _natsPublisher = natsPublisher;
        _materializer = Context.Materializer();

        _readJournal = PersistenceQuery
            .Get(Context.System)
            .ReadJournalFor<SqlReadJournal>(SqlReadJournal.Identifier);

        SubscribeToEventStream();

        Receive<EventEnvelope>(HandleEventEnvelope);
    }

    private void SubscribeToEventStream()
    {
        _readJournal.EventsByTag("auction", Offset.NoOffset())
            .RunForeach(envelope => Self.Tell(envelope), _materializer);

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
                _log.Info("OpenBidding phase started for event {EventId}", _currentEventId);
                break;
            case Session.AuctionFinished evt:
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
            EventId = _currentEventId,
            LotId = (uint)lotId,
            UserId = evt.UserId,
            Amount = evt.Amount,
            CurrentLeaderId = evt.UserId,
            PreviousLeaderId = evt.PreviousLeaderId ?? 0
        };

        _natsPublisher.Publish("events.auction.bid-placed", bidPlacedEvent);
    }

    private void HandleAuctionStarted(AuctionStarted evt)
    {
        _log.Info("Auction started for event {EventId} with {LotCount} lots",
            evt.EventId, evt.LotIds.Count);
        _currentEventId = evt.EventId;
    }

    private void HandleAuctionFinished(Session.AuctionFinished evt)
    {
        _log.Info("Auction finished for event {EventId}", _currentEventId);
    }

    protected override void PostStop()
    {
        _materializer.Dispose();
        base.PostStop();
    }
}
