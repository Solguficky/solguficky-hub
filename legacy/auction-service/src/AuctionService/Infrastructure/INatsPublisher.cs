namespace AuctionService.Infrastructure;

using Google.Protobuf;

public interface INatsPublisher : IDisposable
{
    void Publish(string subject, IMessage message);
}
