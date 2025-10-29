using NotificationsService.Application.Templates;
using NotificationsService.Domain;
using Nats.Events;

namespace NotificationsService.Application.Handlers;

public class BidPlacedHandler
{
    private readonly INatsPublisher _publisher;
    private readonly ILogger<BidPlacedHandler> _logger;

    public BidPlacedHandler(INatsPublisher publisher, ILogger<BidPlacedHandler> logger)
    {
        _publisher = publisher;
        _logger = logger;
    }

    public async Task HandleAsync(BidPlacedEvent evt, CancellationToken ct)
    {
        if (!evt.HasPreviousLeaderId)
        {
            return;
        }

        var text = NotificationTemplates.OutbidNotification(
            evt.LotTitle,
            evt.PreviousAmount,
            evt.Amount);

        await _publisher.PublishSendMessageAsync(evt.PreviousLeaderId, text, ct);

        _logger.LogInformation("Outbid notification sent to {UserId} for lot {LotId}",
            evt.PreviousLeaderId, evt.LotId);
    }
}

