using Microsoft.AspNetCore.SignalR;
using NATS.Client;
using WebSocketGateway.Constants;
using WebSocketGateway.Hubs;

namespace WebSocketGateway.Services;

public class NatsEventListener(
    IConfiguration configuration,
    IHubContext<AuctionHub> hubContext,
    EventMapper eventMapper,
    ILogger<NatsEventListener> logger) : BackgroundService
{
    // `>` — многотокенный wildcard: матчит events.auction.bid_placed и любые
    // будущие события домена. `*` матчит ровно один токен и не подошёл бы.
    private const string NatsSubject = "events.auction.>";
    private IConnection? _natsConnection;
    private IAsyncSubscription? _subscription;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var natsUrl = configuration["Nats:Url"]
            ?? throw new InvalidOperationException("Nats:Url configuration is missing");

        logger.LogInformation("NATS Event Listener starting, connecting to {NatsUrl}", natsUrl);

        var factory = new ConnectionFactory();
        _natsConnection = factory.CreateConnection(natsUrl);

        logger.LogInformation("Connected to NATS, subscribing to {Subject}", NatsSubject);

        _subscription = _natsConnection.SubscribeAsync(NatsSubject);
        _subscription.MessageHandler += async (sender, args) =>
        {
            await ProcessEventAsync(args.Message, stoppingToken);
        };
        _subscription.Start();

        logger.LogInformation("NATS Event Listener started");

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            logger.LogInformation("NATS Event Listener stopping");
        }
    }

    private async Task ProcessEventAsync(Msg msg, CancellationToken ct)
    {
        try
        {
            var eventDto = eventMapper.MapEvent(msg.Subject, msg.Data);

            if (eventDto == null)
            {
                logger.LogWarning("Failed to map event from subject {Subject}, skipping broadcast", msg.Subject);
                return;
            }

            await hubContext.Clients
                .Group(SignalRConstants.Channels.AuctionLive)
                .SendAsync(SignalRConstants.Events.Event, eventDto, ct);

            logger.LogDebug("Event broadcasted to live channel, Subject={Subject}, EventType={EventType}",
                msg.Subject, eventDto.Type);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to process event from subject {Subject}", msg.Subject);
        }
    }

    public override void Dispose()
    {
        _subscription?.Dispose();
        _natsConnection?.Dispose();
        base.Dispose();
    }
}

