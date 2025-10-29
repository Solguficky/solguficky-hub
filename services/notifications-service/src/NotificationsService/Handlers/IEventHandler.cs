using Google.Protobuf;
using NATS.Client;

namespace NotificationsService.Handlers;

public interface IEventHandler
{
    bool CanHandle(Msg msg);
    Task<IEnumerable<IMessage>> HandleAsync(Msg msg, CancellationToken ct);
}
