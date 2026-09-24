using AppHost.Configuration.Topology;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NATS.Client.Core;
using NATS.Client.JetStream;

namespace AppHost.Configuration.Infrastructure;

internal static class NatsSetup
{
    public static IResourceBuilder<NatsServerResource> Configure(ServiceGraphContext context) =>
        context.Builder
            .AddNats(AppHostNames.Resources.Nats)
            .WithImageTag("2.10-alpine")
            .WithJetStream()
            // Без тома рестарт контейнера молча стирает стримы и позиции durable,
            // а outbox к тому моменту уже отметил события отправленными.
            .WithDataVolume("solguficky-nats-data")
            // WaitFor(nats) ждёт не только Healthy, но и завершения обработчиков
            // ResourceReadyEvent: потребитель стартует, когда топология уже есть,
            // а упавшее применение роняет его ожидание. Пока ни один узел nats не
            // ждёт, сбой виден только в логе самого узла — поэтому он там пишется.
            .OnResourceReady(ApplyTopologyAsync);

    private static async Task ApplyTopologyAsync(
        NatsServerResource nats,
        ResourceReadyEvent readyEvent,
        CancellationToken cancellationToken)
    {
        var logger = readyEvent.Services.GetRequiredService<ResourceLoggerService>().GetLogger(nats);
        var url = await nats.ConnectionStringExpression.GetValueAsync(cancellationToken)
            ?? throw new InvalidOperationException($"Aspire assigned no connection string to '{nats.Name}'.");

        await using var connection = new NatsConnection(new NatsOpts { Url = url });
        try
        {
            await JetStreamTopology.ApplyAsync(new NatsJSContext(connection), cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogError(
                exception,
                "JetStream topology was not applied. A change JetStream refuses on a live stream or consumer " +
                "needs the volume 'solguficky-nats-data' removed.");
            throw;
        }

        logger.LogInformation(
            "JetStream topology applied: streams {Streams}; durable consumers {Durables}.",
            string.Join(", ", JetStreamTopology.Streams.Select(stream => stream.Name)),
            string.Join(", ", JetStreamTopology.Durables.Select(durable => durable.Durable)));
    }
}
