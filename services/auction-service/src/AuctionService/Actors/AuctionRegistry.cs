namespace AuctionService.Actors;

using Akka.Actor;
using Akka.Event;
using AuctionService.Actors.Auction;

public class AuctionRegistry : ReceiveActor
{
    private readonly ILoggingAdapter _log = Context.GetLogger();

    public AuctionRegistry()
    {
        Receive<ForwardToLot>(cmd =>
        {
            var auctionActor = GetOrCreateAuction(cmd.AuctionId);
            auctionActor.Tell(new RouteToLot(cmd.LotId, cmd.Command), Sender);
        });

        Receive<ForwardToAuction>(cmd =>
        {
            var auctionActor = GetOrCreateAuction(cmd.AuctionId);
            auctionActor.Forward(cmd.Command);
        });
    }

    private IActorRef GetOrCreateAuction(string auctionId)
    {
        var auctionActor = Context.Child($"auction-{auctionId}");
        if (auctionActor.IsNobody())
        {
            _log.Info("Creating new auction actor for AuctionId: {AuctionId}", auctionId);
            auctionActor = Context.ActorOf(
                Props.Create(() => new AuctionActor(auctionId)),
                $"auction-{auctionId}"
            );
        }

        return auctionActor;
    }
}

public abstract record RegistryCommand;

public sealed record ForwardToLot(string AuctionId, int LotId, Lot.Command Command) : RegistryCommand;

public sealed record ForwardToAuction(string AuctionId, Auction.Command Command) : RegistryCommand;

