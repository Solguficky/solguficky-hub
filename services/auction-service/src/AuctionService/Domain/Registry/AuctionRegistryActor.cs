namespace AuctionService.Domain.Registry;

using Akka.Actor;
using Akka.Event;
using AuctionService.Domain.Session;

public class AuctionRegistryActor : ReceiveActor
{
    private readonly ILoggingAdapter _log = Context.GetLogger();

    public AuctionRegistryActor()
    {
        Receive<RouteLotCommand>(cmd =>
        {
            var sessionActor = GetOrCreateSession(cmd.EventId);
            sessionActor.Tell(new RouteToLot(cmd.LotId, cmd.Command), Sender);
        });

        Receive<GetAuctionSession>(cmd =>
        {
            var sessionActor = Context.Child($"auction-{cmd.EventId}");
            if (sessionActor.IsNobody())
            {
                Sender.Tell(null, Self);
            }
            else
            {
                Sender.Tell(sessionActor, Self);
            }
        });

        Receive<RouteSessionCommand>(cmd =>
        {
            var sessionActor = GetOrCreateSession(cmd.EventId);
            sessionActor.Forward(cmd.Command);
        });
    }

    private IActorRef GetOrCreateSession(string eventId)
    {
        var sessionActor = Context.Child($"auction-{eventId}");
        if (sessionActor.IsNobody())
        {
            _log.Info("Creating new session actor for EventId: {EventId}", eventId);
            sessionActor = Context.ActorOf(
                Props.Create(() => new AuctionSessionActor(eventId)),
                $"auction-{eventId}"
            );
        }

        return sessionActor;
    }
}
