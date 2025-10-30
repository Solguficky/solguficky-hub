using Google.Protobuf;
using Nats.Events;
using WebSocketGateway.Models;

namespace WebSocketGateway.Services;

public class EventMapper(ILogger<EventMapper> logger)
{

    public AuctionEventDto? MapEvent(string subject, byte[] data)
    {
        try
        {
            return subject switch
            {
                "events.auction.bid_placed" => MapBidPlacedEvent(data),
                _ => MapUnknownEvent(subject)
            };
        }
        catch (InvalidProtocolBufferException ex)
        {
            logger.LogError(ex, "Failed to deserialize Protobuf for subject {Subject}", subject);
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to map event for subject {Subject}", subject);
            return null;
        }
    }

    private AuctionEventDto MapBidPlacedEvent(byte[] data)
    {
        var evt = BidPlacedEvent.Parser.ParseFrom(data);

        return new AuctionEventDto(
            Type: "bid_placed",
            Data: new
            {
                event_id = evt.EventId,
                lot_id = evt.LotId,
                user_id = evt.UserId,
                amount = evt.Amount,
                previous_leader_id = evt.HasPreviousLeaderId ? (long?)evt.PreviousLeaderId : null,
                current_leader_id = evt.CurrentLeaderId,
                lot_title = evt.LotTitle,
                previous_amount = evt.PreviousAmount
            },
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        );
    }

    private AuctionEventDto MapUnknownEvent(string subject)
    {
        logger.LogWarning("Received unknown event subject: {Subject}", subject);

        return new AuctionEventDto(
            Type: "unknown",
            Data: new { subject },
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        );
    }
}

