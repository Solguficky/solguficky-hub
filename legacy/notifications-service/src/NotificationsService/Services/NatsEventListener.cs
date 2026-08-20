using NATS.Client;

namespace NotificationsService.Services;

public class NatsEventListener(
    EventDispatcher dispatcher,
    IConfiguration config,
    ILogger<NatsEventListener> logger) : BackgroundService
{
    private IConnection? _connection;
    private readonly List<IAsyncSubscription> _subscriptions = [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var factory = new ConnectionFactory();
        var natsUrl = config["Nats:Url"]!;
        _connection = factory.CreateConnection(natsUrl);

        var subjects = GetSubjectsToSubscribe();

        foreach (var subject in subjects)
        {
            var subscription = _connection.SubscribeAsync(subject);
            subscription.MessageHandler += async (sender, args) =>
            {
                await ProcessMessageAsync(args.Message, stoppingToken);
            };
            subscription.Start();
            _subscriptions.Add(subscription);

            logger.LogInformation("Subscribed to NATS subject: {Subject}", subject);
        }

        logger.LogInformation("NATS Event Listener started, {Count} subscriptions active", _subscriptions.Count);

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            logger.LogInformation("NATS Event Listener stopping");
        }
    }

    private async Task ProcessMessageAsync(Msg msg, CancellationToken ct)
    {
        try
        {
            logger.LogDebug("Received message from subject {Subject}, size={Size} bytes",
                msg.Subject, msg.Data.Length);

            await dispatcher.DispatchAsync(msg, ct);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to process message from subject {Subject}: {Error}",
                msg.Subject, ex.Message);
        }
    }

    private IEnumerable<string> GetSubjectsToSubscribe()
    {
        var subjectsSection = config.GetSection("Nats:Subjects:Events");

        var subjectArray = subjectsSection.Get<string[]>();
        if (subjectArray != null && subjectArray.Length > 0)
        {
            return subjectArray;
        }

        logger.LogWarning("No subjects configured in Nats:Subjects:Events, using fallback");
        return [];
    }

    public override void Dispose()
    {
        logger.LogInformation("Disposing NATS Event Listener");

        foreach (var subscription in _subscriptions)
        {
            subscription.Dispose();
        }
        _subscriptions.Clear();

        _connection?.Dispose();
        base.Dispose();
    }
}
