using System.Diagnostics;
using Notifications.Facts;
using Notifications.Grains;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Notifications.Observability;

namespace Notifications.Replica;

/// <summary>
/// Построение реплики и связанные с ней поводы. Транспорт не знает ни о
/// снимках, ни о задании напоминания, ни об исходах применения реплики.
/// </summary>
public sealed class ReplicaHandler(
    ReplicaFeed feed,
    ReplicaStore store,
    ReplicaTelemetry telemetry,
    FactTelemetry facts,
    IGrainFactory grains,
    TimeProvider clock,
    ILogger<ReplicaHandler> logger) : IEventHandler
{
    public async Task Start(CancellationToken cancellationToken) =>
        telemetry.Seed(feed.Source, await store.LastOccurredAt(feed.Source, cancellationToken));

    public async Task Handle(EventDelivery message, CancellationToken stoppingToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var decoded = feed.Decode(message.Data);
        if (decoded is Decoded.Poison poison)
        {
            telemetry.Record(feed.Source, "poison");
            ReplicaTelemetry.Fail("invariant");
            await message.Reject(stoppingToken);
            Log(LogLevel.Warning, message, startedAt, null, "poison", "invariant", poison.Reason, null);
            return;
        }

        var fact = ((Decoded.Fact)decoded).Event;
        ReplicaApplication application;
        try
        {
            application = await store.Apply(fact, clock.GetUtcNow(), stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            telemetry.Record(feed.Source, "failed");
            ReplicaTelemetry.Fail("dependency_unavailable");
            await message.Retry(stoppingToken);
            Log(LogLevel.Error, message, startedAt, fact, "failed", "dependency_unavailable", "replica apply failed; message returned to the stream", ex);
            return;
        }

        var outcome = application.Outcome;
        var outcomeName = outcome.ToString().ToLowerInvariant();
        telemetry.Record(feed.Source, outcomeName, outcome == ReplicaOutcome.Applied ? fact.OccurredAt : null);
        if (application.Facts is { } produced)
        {
            facts.Record(produced.Type, produced.Facts);
            facts.RecordWithdrawn(NotificationFacts.WithdrawnOnCancellation, produced.Withdrawn ?? []);
        }

        // Повтор несущий: ключ уже записан, но ApplyReplica мог упасть до ACK.
        // Грин читает последнее слово реплики, а не снимок этого события.
        if (fact is MeetupFact meetup)
        {
            try
            {
                await grains.GetGrain<IMeetupNotificationGrain>(meetup.MeetupId.ToString()).ApplyReplica();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                ReplicaTelemetry.Fail("dependency_unavailable");
                await message.Retry(stoppingToken);
                Log(LogLevel.Error, message, startedAt, fact, outcomeName, "dependency_unavailable", "reminder schedule failed; message returned to the stream", ex, application.Facts);
                return;
            }
        }

        await message.Accept(stoppingToken);
        Log(LogLevel.Information, message, startedAt, fact, outcomeName, null, null, null, application.Facts);
    }

    private void Log(
        LogLevel level, EventDelivery message, long startedAt, ReplicaEvent? fact,
        string outcome, string? errorCategory, string? error, Exception? exception,
        ProducedFacts? produced = null)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = message.Subject,
            ["result"] = errorCategory is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["source"] = feed.Source,
            ["outcome"] = outcome,
        };
        if (message.StreamSequence is { } sequence)
        {
            fields["stream_sequence"] = sequence;
        }
        if (fact is not null)
        {
            fields["event_id"] = fact.EventId;
            fields["aggregate_id"] = fact.AggregateId;
            fields["version"] = fact.Version;
            fields["event_age_seconds"] = (clock.GetUtcNow() - fact.OccurredAt).TotalSeconds;
            if (fact is MeetupFact { RequestId: { } requestId })
            {
                fields["request_id"] = requestId;
            }
        }
        if (produced is not null)
        {
            fields["occasion"] = produced.Type;
            fields["facts_created"] = produced.Facts.Created;
            fields["facts_suppressed"] = produced.Facts.Suppressed;
            if (produced.Withdrawn is { } withdrawn)
            {
                fields["facts_withdrawn"] = withdrawn.Sum(facts => facts.Count);
            }
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
        OperationLog.Write(logger, level, exception, fields);
    }
}
