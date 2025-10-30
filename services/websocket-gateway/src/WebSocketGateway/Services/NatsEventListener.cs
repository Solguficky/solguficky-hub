using Microsoft.AspNetCore.SignalR;
using NATS.Client;
using WebSocketGateway.Hubs;

namespace WebSocketGateway.Services;

public class NatsEventListener : BackgroundService
{
    private readonly IConnection _natsConnection;
    private readonly IHubContext<AuctionHub> _hubContext;
    private readonly EventMapper _eventMapper;
    private readonly ILogger<NatsEventListener> _logger;
    private const string LiveChannelName = "auction:live";
    private const string NatsSubject = "events.auction.*";
    private IAsyncSubscription? _subscription;

    public NatsEventListener(
        IConnection natsConnection,
        IHubContext<AuctionHub> hubContext,
        EventMapper eventMapper,
        ILogger<NatsEventListener> logger)
    {
        _natsConnection = natsConnection;
        _hubContext = hubContext;
        _eventMapper = eventMapper;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("NATS Event Listener starting, subscribing to {Subject}", NatsSubject);

        _subscription = _natsConnection.SubscribeAsync(NatsSubject);
        _subscription.MessageHandler += async (sender, args) =>
        {
            await ProcessEventAsync(args.Message, stoppingToken);
        };
        _subscription.Start();

        _logger.LogInformation("NATS Event Listener started");

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("NATS Event Listener stopping");
        }
    }

    private async Task ProcessEventAsync(Msg msg, CancellationToken ct)
    {
        try
        {
            var eventDto = _eventMapper.MapEvent(msg.Subject, msg.Data);

            if (eventDto == null)
            {
                _logger.LogWarning("Failed to map event from subject {Subject}, skipping broadcast", msg.Subject);
                return;
            }

            await _hubContext.Clients
                .Group(LiveChannelName)
                .SendAsync("AuctionEvent", eventDto, ct);

            _logger.LogDebug("Event broadcasted to live channel, Subject={Subject}, EventType={EventType}",
                msg.Subject, eventDto.Type);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process event from subject {Subject}", msg.Subject);
        }
    }

    public override void Dispose()
    {
        _subscription?.Dispose();
        base.Dispose();
    }
}

