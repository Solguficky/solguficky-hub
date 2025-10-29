using NATS.Client;
using Google.Protobuf;
using NotificationsService.Domain;
using Nats.Commands;

namespace NotificationsService.Application.Services;

public class NatsPublisher : INatsPublisher, IDisposable
{
    private readonly IConnection _connection;
    private readonly string _subject;
    private readonly ILogger<NatsPublisher> _logger;

    public NatsPublisher(IConfiguration config, ILogger<NatsPublisher> logger)
    {
        _logger = logger;
        var factory = new ConnectionFactory();
        _connection = factory.CreateConnection(config["Nats:Url"]!);
        _subject = config["Nats:Subjects:SendMessage"]!;

        _logger.LogInformation("NATS Publisher initialized with subject {Subject}", _subject);
    }

    public Task PublishSendMessageAsync(long chatId, string text, CancellationToken ct)
    {
        var command = new SendMessageCommand
        {
            ChatId = chatId,
            Text = text,
            ParseMode = ""
        };

        var payload = command.ToByteArray();
        _connection.Publish(_subject, payload);
        _connection.Flush();

        _logger.LogDebug("Published send-message command for chat {ChatId}", chatId);

        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _connection?.Dispose();
    }
}

