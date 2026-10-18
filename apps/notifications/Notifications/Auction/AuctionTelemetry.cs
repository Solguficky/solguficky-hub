using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Notifications.Auction;

/// <summary>Исходы обработки поводов; это не возраст снимка реплики.</summary>
public sealed class AuctionTelemetry : IDisposable
{
    public const string MeterName = "notifications.auction";
    private readonly Meter meter = new(MeterName);
    private readonly Counter<long> events;
    private readonly ConcurrentDictionary<string, long> totals = new();
    public AuctionTelemetry() => events = meter.CreateCounter<long>("notifications.auction.events");
    public long Total(string outcome) => totals.GetValueOrDefault(outcome);
    public void Record(string outcome)
    {
        events.Add(1, new KeyValuePair<string, object?>("outcome", outcome));
        totals.AddOrUpdate(outcome, 1, (_, count) => count + 1);
    }
    public void Dispose() => meter.Dispose();
}
