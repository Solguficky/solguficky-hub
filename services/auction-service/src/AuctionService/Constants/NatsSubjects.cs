namespace AuctionService.Constants;

public static class NatsSubjects
{
    public static class Commands
    {
        public const string PlaceBid = "commands.auction.place_bid";
        public const string SetProxyBid = "commands.auction.set_proxy_bid";
        public const string StartAuction = "commands.auction.start";
        public const string EndOpenBidding = "commands.auction.end_open_bidding";
        public const string StartFinalPhase = "commands.auction.start_final_phase";
    }

    public static class Events
    {
        public const string BidPlaced = "events.auction.bid_placed";
        public const string AuctionStarted = "events.auction.started";
        public const string PhaseTransitioned = "events.auction.phase_transitioned";
    }
}

