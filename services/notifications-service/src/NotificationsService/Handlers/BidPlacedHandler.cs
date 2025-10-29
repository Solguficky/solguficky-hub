using Google.Protobuf;
using NATS.Client;
using Nats.Commands;
using Nats.Events;
using NotificationsService.Attributes;
using NotificationsService.Templates;

namespace NotificationsService.Handlers;

[HandlesSubject("events.auction.bid_placed")]
public class BidPlacedHandler(ILogger<BidPlacedHandler> logger) : IEventHandler
{
    private BidPlacedEvent? _cachedEvent;

    public bool CanHandle(Msg msg)
    {
        // Check subject first
        if (msg.Subject != "events.auction.bid_placed")
        {
            return false;
        }

        try
        {
            _cachedEvent = BidPlacedEvent.Parser.ParseFrom(msg.Data);

            logger.LogDebug("BidPlaced event: lot={LotId}, has_previous_leader={HasLeader}",
                _cachedEvent.LotId, _cachedEvent.HasPreviousLeaderId);

            return _cachedEvent.HasPreviousLeaderId;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to parse BidPlacedEvent from subject {Subject}", msg.Subject);
            _cachedEvent = null;
            return false;
        }
    }

    public Task<IEnumerable<IMessage>> HandleAsync(Msg msg, CancellationToken ct)
    {
        var evt = _cachedEvent ?? BidPlacedEvent.Parser.ParseFrom(msg.Data);

        logger.LogInformation("Creating outbid notification for user {UserId}, lot {LotId}",
            evt.PreviousLeaderId, evt.LotId);

        var text = NotificationTemplates.OutbidNotification(
            evt.LotTitle,
            evt.PreviousAmount,
            evt.Amount);

        // TODO: MVP limitation - using user_id as chat_id directly
        // Future: fetch chat_id from Identity Service or user preferences
        var command = new SendMessageCommand
        {
            ChatId = evt.PreviousLeaderId, // Temporary: assuming user_id == chat_id
            Text = text,
            ParseMode = NotificationTemplates.DefaultParseMode
        };

        IEnumerable<IMessage> commands = [command];
        return Task.FromResult(commands);
    }
}
