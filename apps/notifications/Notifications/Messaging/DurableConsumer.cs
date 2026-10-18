using Microsoft.Extensions.Options;
using NATS.Client.Core;
using NATS.Client.JetStream;

namespace Notifications.Messaging;

/// <summary>
/// Общий транспорт: bind, проверка окна ключей, чтение и восстановление связи.
/// Эффект события, исход обработки и запись его лога принадлежат handler'у.
/// Durable создаёт топология, никогда не сервис.
/// </summary>
public sealed class DurableConsumer(
    EventFeed feed,
    IEventHandler handler,
    INatsJSContext jetStream,
    ConsumerBindings bindings,
    IOptions<ConsumerOptions> options,
    TimeProvider clock,
    ILogger<DurableConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await handler.Start(stoppingToken);
        if (await Bind(stoppingToken) is not { } consumer)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await foreach (var message in consumer.ConsumeAsync<byte[]>(cancellationToken: stoppingToken))
                {
                    await handler.Handle(new EventDelivery(message, options.Value.RetryDelay), stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Consumer {durable} stopped reading; resuming", feed.Durable);
                await Pause(stoppingToken);
            }
        }
    }

    private async Task<INatsJSConsumer?> Bind(CancellationToken stoppingToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var stream = await jetStream.GetStreamAsync(feed.Stream, cancellationToken: stoppingToken);
                var maxAge = stream.Info.Config.MaxAge;
                if (maxAge <= TimeSpan.Zero || maxAge > options.Value.KeyRetention)
                {
                    throw new InvalidOperationException(
                        $"Stream {feed.Stream} keeps messages for {(maxAge <= TimeSpan.Zero ? "unlimited time" : maxAge)}, " +
                        $"longer than {ConsumerOptions.SectionName}:KeyRetention {options.Value.KeyRetention}: a redelivery after key pruning would apply twice.");
                }

                var consumer = await jetStream.GetConsumerAsync(feed.Stream, feed.Durable, stoppingToken);
                bindings.Bound(feed);
                logger.LogInformation("Consumer bound to {durable} on {stream} for {source} on attempt {attempt}",
                    feed.Durable, feed.Stream, feed.Source, attempt);
                return consumer;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return null;
            }
            catch (Exception ex) when (IsTransient(ex))
            {
                bindings.Retrying(feed, ex);
                ConsumerFailures.Record("dependency_unavailable");
                logger.LogError(ex, "Consumer {durable} not bound on attempt {attempt}; retrying in {delay}",
                    feed.Durable, attempt, options.Value.RetryDelay);
                await Pause(stoppingToken);
                if (stoppingToken.IsCancellationRequested)
                {
                    return null;
                }
            }
            catch (Exception ex)
            {
                bindings.Failed(feed, ex);
                throw;
            }
        }
    }

    // Только явно транзиентные ответы сервера повторяются. Нет durable,
    // неверные credentials и выключенный JetStream — ошибки развёртывания.
    public static bool IsTransient(Exception failure) => failure switch
    {
        NatsJSApiException { Error: { Code: 503, ErrCode: 10008 } } => true,
        NatsJSApiException => false,
        NatsNoRespondersException => false,
        NatsServerException => false,
        NatsException { InnerException: NatsServerException } => false,
        NatsException => true,
        _ => false,
    };

    private async Task Pause(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(options.Value.RetryDelay, clock, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }
}
