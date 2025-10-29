using System.Reflection;
using NATS.Client;
using Google.Protobuf;
using NotificationsService.Attributes;

namespace NotificationsService.Services;

public class NatsPublisher : INatsPublisher, IDisposable
{
    private readonly IConnection _connection;
    private readonly ILogger<NatsPublisher> _logger;

    public NatsPublisher(IConfiguration config, ILogger<NatsPublisher> logger)
    {
        _logger = logger;
        var factory = new ConnectionFactory();
        var natsUrl = config["Nats:Url"]!;
        _connection = factory.CreateConnection(natsUrl);

        _logger.LogInformation("NATS Publisher initialized, connected to {Url}", natsUrl);
    }

    public Task PublishAsync(string subject, IMessage message, CancellationToken ct = default)
    {
        try
        {
            var payload = message.ToByteArray();

            _logger.LogDebug("Publishing {MessageType} to subject {Subject}, size={Size} bytes",
                message.GetType().Name, subject, payload.Length);

            _connection.Publish(subject, payload);
            _connection.Flush();

            _logger.LogInformation("Message published: subject={Subject}, type={MessageType}",
                subject, message.GetType().Name);

            return Task.CompletedTask;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to publish message to {Subject}: {Error}",
                subject, ex.Message);
            throw;
        }
    }

    public Task PublishAsync<T>(T message, CancellationToken ct = default) where T : IMessage
    {
        var attribute = typeof(T).GetCustomAttribute<NatsSubjectAttribute>();

        if (attribute == null)
        {
            throw new InvalidOperationException(
                $"Type {typeof(T).Name} does not have [NatsSubject] attribute. " +
                $"Use PublishAsync(string subject, IMessage message) overload instead.");
        }

        return PublishAsync(attribute.Subject, message, ct);
    }

    public void Dispose()
    {
        _logger.LogInformation("Disposing NATS Publisher connection");
        _connection?.Dispose();
    }
}

