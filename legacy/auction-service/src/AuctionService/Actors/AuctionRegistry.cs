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
            auctionActor.Tell(new Auction.ForwardToLot(cmd.LotId, cmd.LotCommand), Sender);
        });

        Receive<ForwardToAuction>(cmd =>
        {
            var auctionActor = GetOrCreateAuction(cmd.AuctionId);
            auctionActor.Forward(cmd.Command);
        });
    }

    private IActorRef GetOrCreateAuction(Guid auctionId)
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

public sealed record ForwardToLot(Guid AuctionId, int LotId, Lot.Command LotCommand) : RegistryCommand;

public sealed record ForwardToAuction(Guid AuctionId, Auction.Command Command) : RegistryCommand;

