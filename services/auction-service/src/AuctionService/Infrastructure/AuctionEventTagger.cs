namespace AuctionService.Infrastructure;

using Akka.Actor;
using Akka.Persistence.Journal;

public class AuctionEventTagger : IWriteEventAdapter
{
    public string Manifest(object evt) => string.Empty;

    public object ToJournal(object evt)
    {
        return new Tagged(evt, new[] { "auction" });
    }
}

