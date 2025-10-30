namespace AuctionService.Actors.Lot;

using Akka.Actor;
using Akka.Event;
using Akka.Persistence;

public class LotActor : ReceivePersistentActor, IWithTimers
{
    public ITimerScheduler Timers { get; set; } = null!;
    private const string AuctionTimerKey = "auction-timer";

    public override string PersistenceId { get; }
    private State _state;
    private readonly ILoggingAdapter _log = Context.GetLogger();

    public LotActor(int lotId, double startingPrice, double minBidStep)
    {
        PersistenceId = $"lot-{lotId}";
        _state = State.Empty(lotId, startingPrice, minBidStep);

        Command<PlaceBid>(HandlePlaceBid);
        Command<GetStatus>(HandleGetStatus);
        Command<StartLotTimer>(HandleStartLotTimer);
        Command<SetProxyBid>(HandleSetProxyBid);
        Command<AuctionTimerTick>(HandleAuctionTimerTick);

        Recover<BidPlaced>(ApplyBidPlaced);
        Recover<LotSold>(ApplyLotSold);
        Recover<LotTimerExtended>(ApplyLotTimerExtended);
        Recover<AuctionFinished>(ApplyAuctionFinished);
        Recover<ProxyBidSet>(ApplyProxyBidSet);
        Recover<SnapshotOffer>(offer => _state = (State)offer.Snapshot);
    }

    private void HandleSetProxyBid(SetProxyBid cmd)
    {
        if (_state.IsFinished)
        {
            Sender.Tell(new BidRejected("Auction has finished"), Self);
            return;
        }

        var evt = new ProxyBidSet(cmd.UserId, cmd.MaxAmount, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, ApplyProxyBidSet);
    }

    private void HandleStartLotTimer(StartLotTimer cmd)
    {
        if (_state.EndTime is not null) return;

        var endTime = DateTimeOffset.UtcNow.AddSeconds(60);
        var evt = new LotTimerExtended(endTime, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyLotTimerExtended(e);
            Timers.StartSingleTimer(AuctionTimerKey, new AuctionTimerTick(), TimeSpan.FromSeconds(1));
        });
    }

    private void HandleAuctionTimerTick(AuctionTimerTick cmd)
    {
        if (_state.IsFinished || _state.EndTime is null) return;

        if (DateTimeOffset.UtcNow > _state.EndTime)
        {
            var evt = new AuctionFinished(_state.CurrentLeaderId, _state.CurrentPrice, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            Persist(evt, ApplyAuctionFinished);
        }
        else
        {
            Timers.StartSingleTimer(AuctionTimerKey, new AuctionTimerTick(), TimeSpan.FromSeconds(1));
        }
    }

    private void HandlePlaceBid(PlaceBid cmd)
    {
        if (_state.IsFinished)
        {
            Sender.Tell(new BidRejected("Auction for this lot has finished."), Self);
            return;
        }

        var minRequired = (_state.CurrentPrice ?? _state.StartingPrice) + _state.MinBidStep;
        if (cmd.Amount < minRequired)
        {
            Sender.Tell(new BidRejected($"Minimum bid required: {minRequired}"), Self);
            return;
        }

        var previousLeader = _state.CurrentLeaderId;
        var evt = new BidPlaced(
            cmd.UserId,
            cmd.Amount,
            previousLeader,
            DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        );

        Persist(evt, e =>
        {
            ApplyBidPlaced(e);
            Sender.Tell(new BidAccepted(cmd.Amount), Self);

            CheckProxyBids();

            if (_state.EndTime.HasValue && _state.EndTime.Value.Subtract(DateTimeOffset.UtcNow) < TimeSpan.FromSeconds(15))
            {
                var newEndTime = DateTimeOffset.UtcNow.AddSeconds(15);
                var timerEvent = new LotTimerExtended(newEndTime, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                Persist(timerEvent, ApplyLotTimerExtended);
            }
        });
    }

    private void CheckProxyBids()
    {
        var currentPrice = _state.CurrentPrice ?? _state.StartingPrice;

        var contender = _state.ProxyBids
            .Where(pb => pb.Key != _state.CurrentLeaderId && pb.Value > currentPrice)
            .OrderByDescending(pb => pb.Value)
            .ThenBy(pb => pb.Key)
            .Select(pb => (UserId: pb.Key, MaxBid: pb.Value))
            .FirstOrDefault();

        if (contender == default)
        {
            return;
        }

        double nextBid;
        if (_state.CurrentLeaderId.HasValue && _state.ProxyBids.TryGetValue(_state.CurrentLeaderId.Value, out var leaderMaxBid))
        {
            nextBid = Math.Min(contender.MaxBid, leaderMaxBid + _state.MinBidStep);
        }
        else
        {
            nextBid = currentPrice + _state.MinBidStep;
        }

        nextBid = Math.Min(nextBid, contender.MaxBid);

        if (nextBid > currentPrice)
        {
            var previousLeader = _state.CurrentLeaderId;
            var evt = new BidPlaced(
                contender.UserId,
                nextBid,
                previousLeader,
                DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            );

            Persist(evt, e =>
            {
                ApplyBidPlaced(e);
                CheckProxyBids();
            });
        }
    }

    private void HandleGetStatus(GetStatus cmd)
    {
        Sender.Tell(new StatusResponse(
            _state.CurrentPrice ?? _state.StartingPrice,
            _state.CurrentLeaderId,
            _state.EndTime
        ), Self);
    }

    private void ApplyBidPlaced(BidPlaced evt)
    {
        _state = _state with
        {
            CurrentPrice = evt.Amount,
            CurrentLeaderId = evt.UserId,
            Bids = _state.Bids.Add(evt)
        };
    }

    private void ApplyProxyBidSet(ProxyBidSet evt)
    {
        _state = _state with { ProxyBids = _state.ProxyBids.SetItem(evt.UserId, evt.MaxAmount) };
    }

    private void ApplyLotTimerExtended(LotTimerExtended evt)
    {
        _state = _state with { EndTime = evt.NewEndTime };
    }

    private void ApplyAuctionFinished(AuctionFinished evt)
    {
        _state = _state with { IsFinished = true };
    }

    private void ApplyLotSold(LotSold evt)
    {
        _state = _state with { IsFinished = true };
    }
}

