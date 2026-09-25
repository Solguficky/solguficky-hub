using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Options;
using NATS.Client.JetStream;
using Notifications.Infrastructure;

namespace Notifications.Replica;

/// <summary>
/// Потребитель одного потока чужих фактов: читает свой durable и применяет
/// каждое сообщение к реплике.
/// </summary>
/// <remarks>
/// Подтверждение идёт только после коммита. Упавший между коммитом и
/// подтверждением процесс получит сообщение снова, и оно придёт как
/// <see cref="ReplicaOutcome.Duplicate" /> — ради этого ключ и пишется той же
/// транзакцией, что и эффект.
///
/// Durable сервис не создаёт: его заводит топология AppHost, а отсутствие
/// durable — поломка развёртывания, и сервис на ней падает, а не молча
/// заводит свой с другими настройками (docs/architecture/integration.md).
///
/// Консьюмер — граница сервиса (docs/standards/observability/logging.md):
/// каждое сообщение даёт ровно одну запись с каркасом, и отказ пишется здесь
/// же, а не в хранилище под ним.
/// </remarks>
public sealed class ReplicaConsumer(
    ReplicaFeed feed,
    INatsJSContext jetStream,
    ReplicaStore store,
    ReplicaTelemetry telemetry,
    IOptions<ReplicaOptions> options,
    TimeProvider clock,
    ILogger<ReplicaConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        telemetry.Seed(feed.Source, await store.LastOccurredAt(feed.Source, stoppingToken));

        // Без перехвата: хост роняет и отсутствующий durable, и шина,
        // недоступная на старте. Второго в развёртывании не бывает — Aspire
        // стартует сервис после готовности узла nats и применения топологии.
        await EnsureKeysOutliveStream(stoppingToken);
        var consumer = await jetStream.GetConsumerAsync(feed.Stream, feed.Durable, stoppingToken);

        logger.LogInformation(
            "Replica consumer bound to {durable} on {stream} for {source}",
            feed.Durable,
            feed.Stream,
            feed.Source);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await foreach (var message in consumer.ConsumeAsync<byte[]>(cancellationToken: stoppingToken))
                {
                    await Handle(message, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // После привязки чтение не роняет хост ни на разрыве связи, ни
                // на durable, удалённом из-под живого сервиса: первое лечится
                // само, второе — только применением топологии. Оба видны
                // строкой ошибки на каждом повторе, а неподтверждённое сервер
                // вернёт, так что ничего не теряется.
                logger.LogError(ex, "Replica consumer {durable} stopped reading; resuming", feed.Durable);
                await Pause(options.Value.RetryDelay, stoppingToken);
            }
        }
    }

    /// <summary>
    /// Ключ дедупликации обязан жить не меньше, чем стрим способен доставить
    /// повтор. Сверяется с настоящим стримом, а не с копией его настройки:
    /// топология, поднявшая окно хранения, иначе прошла бы молча, и повтор
    /// после чистки ключа применился бы как новое событие.
    /// </summary>
    private async Task EnsureKeysOutliveStream(CancellationToken stoppingToken)
    {
        var stream = await jetStream.GetStreamAsync(feed.Stream, cancellationToken: stoppingToken);
        var maxAge = stream.Info.Config.MaxAge;
        var retention = options.Value.KeyRetention;

        if (maxAge <= TimeSpan.Zero || maxAge > retention)
        {
            throw new InvalidOperationException(
                $"Stream {feed.Stream} keeps messages for {(maxAge <= TimeSpan.Zero ? "unlimited time" : maxAge)}, " +
                $"longer than {ReplicaOptions.SectionName}:KeyRetention {retention}: a redelivery after key pruning would apply twice.");
        }
    }

    private async Task Handle(INatsJSMsg<byte[]> message, CancellationToken stoppingToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var decoded = feed.Decode(message.Data ?? []);

        if (decoded is Decoded.Poison poison)
        {
            // Повтор нарушенного контракта ничего не исправит, поэтому сообщение
            // снимается с доставки. Dead-letter нет до PER-72, и единственный
            // след сообщения — эта запись.
            telemetry.Record(feed.Source, "poison");
            ReplicaTelemetry.Fail("invariant");
            await message.AckTerminateAsync(cancellationToken: stoppingToken);
            Log(LogLevel.Warning, message, startedAt, null, "poison", "invariant", poison.Reason, null);
            return;
        }

        var fact = ((Decoded.Fact)decoded).Event;
        ReplicaOutcome outcome;

        try
        {
            outcome = await store.Apply(fact, clock.GetUtcNow(), stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Без подтверждения: сервер вернёт сообщение следующему запуску.
            throw;
        }
        catch (Exception ex)
        {
            telemetry.Record(feed.Source, "failed");
            ReplicaTelemetry.Fail("dependency_unavailable");
            await message.NakAsync(delay: options.Value.RetryDelay, cancellationToken: stoppingToken);
            Log(LogLevel.Error, message, startedAt, fact, "failed", "dependency_unavailable", "replica apply failed; message returned to the stream", ex);
            return;
        }

        var outcomeName = outcome.ToString().ToLowerInvariant();
        telemetry.Record(feed.Source, outcomeName, outcome == ReplicaOutcome.Applied ? fact.OccurredAt : null);
        await message.AckAsync(cancellationToken: stoppingToken);
        Log(LogLevel.Information, message, startedAt, fact, outcomeName, null, null, null);
    }

    private void Log(
        LogLevel level,
        INatsJSMsg<byte[]> message,
        long startedAt,
        ReplicaEvent? fact,
        string outcome,
        string? errorCategory,
        string? error,
        Exception? exception)
    {
        // JSON в теле строки — та же форма, что у снимка sweeper'а: LogQL
        // получает числовые поля без привязки к раскладке атрибутов OTLP.
        // use_case и request_id опущены, а не пусты: сообщение шины человек не
        // начинал, а сквозной идентификатор конверт пока не несёт (PER-70).
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = message.Subject,
            ["result"] = errorCategory is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["source"] = feed.Source,
            ["outcome"] = outcome,
        };

        if (message.Metadata is { } metadata)
        {
            fields["stream_sequence"] = metadata.Sequence.Stream;
        }

        if (fact is not null)
        {
            fields["event_id"] = fact.EventId;
            fields["aggregate_id"] = fact.AggregateId;
            fields["version"] = fact.Version;
            fields["event_age_seconds"] = (clock.GetUtcNow() - fact.OccurredAt).TotalSeconds;
        }

        if (telemetry.AgeSeconds(feed.Source) is { } age)
        {
            fields["last_applied_age_seconds"] = age;
        }

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = error ?? errorCategory;
        }

        logger.Log(level, exception, "{replica_apply}", JsonSerializer.Serialize(fields));
    }

    private async Task Pause(TimeSpan delay, CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(delay, clock, stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }
    }
}
