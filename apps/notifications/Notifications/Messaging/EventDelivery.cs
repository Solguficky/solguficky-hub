using NATS.Client.JetStream;

namespace Notifications.Messaging;

/// <summary>
/// Сообщение и решения о его доставке. ACK выполняется только после эффекта;
/// отказ обработки возвращает сообщение, нарушение формы снимает его.
/// </summary>
public sealed class EventDelivery(INatsJSMsg<byte[]> message, TimeSpan retryDelay)
{
    public string Subject => message.Subject;
    public ReadOnlyMemory<byte> Data => message.Data ?? [];
    public ulong? StreamSequence => message.Metadata?.Sequence.Stream;

    public ValueTask Accept(CancellationToken cancellationToken) => message.AckAsync(cancellationToken: cancellationToken);
    public ValueTask Reject(CancellationToken cancellationToken) => message.AckTerminateAsync(cancellationToken: cancellationToken);
    public ValueTask Retry(CancellationToken cancellationToken) => message.NakAsync(delay: retryDelay, cancellationToken: cancellationToken);
}
