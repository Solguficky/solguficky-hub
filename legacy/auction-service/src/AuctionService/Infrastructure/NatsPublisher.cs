namespace AuctionService.Infrastructure;

using Google.Protobuf;
using NATS.Client;

public class NatsPublisher : INatsPublisher
{
    private readonly IConnection _natsConnection;

    public NatsPublisher(IConfiguration configuration)
    {
        var natsUrl = configuration["Nats:Url"] ?? throw new InvalidOperationException("Nats:Url is not configured.");
        _natsConnection = new ConnectionFactory().CreateConnection(natsUrl);
    }

    public void Publish(string subject, IMessage message)
    {
        _natsConnection.Publish(subject, message.ToByteArray());
    }

    public void Dispose()
    {
        _natsConnection.Dispose();
    }
}
