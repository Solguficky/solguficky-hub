using Google.Protobuf;

namespace NotificationsService.Services;

public interface INatsPublisher
{
    Task PublishAsync(string subject, IMessage message, CancellationToken ct = default);
    Task PublishAsync<T>(T message, CancellationToken ct = default) where T : IMessage;
}

