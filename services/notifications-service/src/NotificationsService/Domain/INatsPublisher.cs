namespace NotificationsService.Domain;

public interface INatsPublisher
{
    Task PublishSendMessageAsync(long chatId, string text, CancellationToken ct = default);
}

