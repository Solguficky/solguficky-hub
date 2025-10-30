using Microsoft.AspNetCore.SignalR;
using WebSocketGateway.Constants;

namespace WebSocketGateway.Hubs;

public class AuctionHub(ILogger<AuctionHub> logger) : Hub
{
    public async Task SubscribeToAuction()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, SignalRConstants.Channels.AuctionLive);

        logger.LogInformation("Client subscribed to live auction channel, ConnectionId={ConnectionId}",
            Context.ConnectionId);
    }

    public async Task UnsubscribeFromAuction()
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, SignalRConstants.Channels.AuctionLive);

        logger.LogInformation("Client unsubscribed from live auction channel, ConnectionId={ConnectionId}",
            Context.ConnectionId);
    }

    public override async Task OnConnectedAsync()
    {
        logger.LogInformation("Client connected, ConnectionId={ConnectionId}",
            Context.ConnectionId);

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("Client disconnected, ConnectionId={ConnectionId}, Exception={Exception}",
            Context.ConnectionId, exception?.Message);

        await base.OnDisconnectedAsync(exception);
    }
}

