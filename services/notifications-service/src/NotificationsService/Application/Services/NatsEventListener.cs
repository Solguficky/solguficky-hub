using NATS.Client;
using NotificationsService.Application.Handlers;
using Nats.Events;

namespace NotificationsService.Application.Services;

public class NatsEventListener : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly IConfiguration _config;
    private readonly ILogger<NatsEventListener> _logger;
    private IConnection? _connection;
    private IAsyncSubscription? _subscription;

    public NatsEventListener(
        IServiceProvider serviceProvider,
        IConfiguration config,
        ILogger<NatsEventListener> logger)
    {
        _serviceProvider = serviceProvider;
        _config = config;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var factory = new ConnectionFactory();
        _connection = factory.CreateConnection(_config["Nats:Url"]!);
        var subject = _config["Nats:Subjects:BidPlaced"]!;

        _subscription = _connection.SubscribeAsync(subject);
        _subscription.MessageHandler += async (sender, args) =>
        {
            await ProcessMessageAsync(args.Message, stoppingToken);
        };
        _subscription.Start();

        _logger.LogInformation("Subscribed to {Subject}", subject);

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("Service stopping");
        }
    }

    private async Task ProcessMessageAsync(Msg msg, CancellationToken ct)
    {
        try
        {
            var evt = BidPlacedEvent.Parser.ParseFrom(msg.Data);

            using var scope = _serviceProvider.CreateScope();
            var handler = scope.ServiceProvider.GetRequiredService<BidPlacedHandler>();

            await handler.HandleAsync(evt, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process event from {Subject}", msg.Subject);
        }
    }

    public override void Dispose()
    {
        _subscription?.Dispose();
        _connection?.Dispose();
        base.Dispose();
    }
}

