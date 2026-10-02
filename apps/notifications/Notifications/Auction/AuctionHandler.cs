using System.Diagnostics;
using Notifications.Facts;
using Notifications.Messaging;
using Notifications.Observability;

namespace Notifications.Auction;

/// <summary>Граница аукционных поводов со своими исходами и логами.</summary>
public sealed class AuctionHandler(AuctionStore store, AuctionTelemetry telemetry, FactTelemetry facts,
    TimeProvider clock, ILogger<AuctionHandler> logger) : IEventHandler
{
    public Task Start(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task Handle(EventDelivery message, CancellationToken stoppingToken)
    {
        var started = Stopwatch.GetTimestamp();
        var decoded = AuctionMapping.Decode(message.Subject, message.Data);
        if (decoded is AuctionDecoded.Ignored)
        {
            await message.Accept(stoppingToken);
            Record(message, started, null, "ignored", 0);
            return;
        }
        if (decoded is AuctionDecoded.Poison poison)
        {
            await message.Reject(stoppingToken);
            Record(message, started, null, "poison", 0, "invariant", poison.Reason);
            return;
        }
        var bid = ((AuctionDecoded.Bid)decoded).Value;
        AuctionApplication application;
        try
        {
            application = await store.Apply(bid, clock.GetUtcNow(), stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            await message.Retry(stoppingToken);
            Record(message, started, bid, "failed", 0, "dependency_unavailable", "auction cause apply failed; message returned to the stream", ex);
            return;
        }
        facts.Record(AuctionFacts.OutbidType, new FactCount(application.FactsCreated, 0));
        await message.Accept(stoppingToken);
        Record(message, started, bid, application.Outcome switch
        {
            AuctionOutcome.Outbid => "outbid",
            AuctionOutcome.FirstBid => "first_bid",
            AuctionOutcome.LeaderUnchanged => "leader_unchanged",
            AuctionOutcome.Duplicate => "duplicate",
            _ => throw new ArgumentOutOfRangeException(nameof(application)),
        }, application.FactsCreated);
    }

    private void Record(EventDelivery message, long started, AuctionBid? bid, string outcome, int created,
        string? category = null, string? error = null, Exception? exception = null)
    {
        telemetry.Record(outcome);
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = message.Subject,
            ["result"] = category is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(started).TotalMicroseconds,
            ["source"] = AuctionFeed.Source,
            ["outcome"] = outcome,
            ["facts_created"] = created,
        };
        if (message.StreamSequence is { } sequence) fields["stream_sequence"] = sequence;
        if (bid is not null)
        {
            fields["event_id"] = bid.EventId;
            fields["lot_id"] = bid.LotId;
            fields["version"] = bid.Version;
            fields["event_age_seconds"] = (clock.GetUtcNow() - bid.OccurredAt).TotalSeconds;
        }
        if (category is not null)
        {
            ConsumerFailures.Record(category);
            fields["error_category"] = category;
            fields["error"] = error ?? category;
        }
        OperationLog.Write(logger, category is null ? LogLevel.Information : exception is null ? LogLevel.Warning : LogLevel.Error,
            exception, fields);
    }
}
