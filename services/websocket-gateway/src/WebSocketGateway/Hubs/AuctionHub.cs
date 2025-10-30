using Microsoft.AspNetCore.SignalR;

namespace WebSocketGateway.Hubs;

public class AuctionHub : Hub
{
    private readonly ILogger<AuctionHub> _logger;
    private const string LiveChannelName = "auction:live";

    public AuctionHub(ILogger<AuctionHub> logger)
    {
        _logger = logger;
    }

    public async Task SubscribeToAuction()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, LiveChannelName);

        _logger.LogInformation("Client subscribed to live auction channel, ConnectionId={ConnectionId}",
            Context.ConnectionId);
    }

    public async Task UnsubscribeFromAuction()
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, LiveChannelName);

        _logger.LogInformation("Client unsubscribed from live auction channel, ConnectionId={ConnectionId}",
            Context.ConnectionId);
    }

    public override async Task OnConnectedAsync()
    {
        _logger.LogInformation("Client connected, ConnectionId={ConnectionId}",
            Context.ConnectionId);

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _logger.LogInformation("Client disconnected, ConnectionId={ConnectionId}, Exception={Exception}",
            Context.ConnectionId, exception?.Message);

        await base.OnDisconnectedAsync(exception);
    }
}

