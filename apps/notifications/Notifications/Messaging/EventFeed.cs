namespace Notifications.Messaging;

/// <summary>Адрес потока; ни декодирования, ни бизнес-цели транспорт не знает.</summary>
public record EventFeed(string Source, string Stream, string Durable);

/// <summary>Модуль обработки сообщений за общим транспортом JetStream.</summary>
public interface IEventHandler
{
    Task Start(CancellationToken cancellationToken);
    Task Handle(EventDelivery message, CancellationToken cancellationToken);
}
