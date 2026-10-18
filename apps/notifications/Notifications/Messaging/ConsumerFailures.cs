using System.Diagnostics.Metrics;

namespace Notifications.Messaging;

/// <summary>Межсервисный счётчик отказов, не метрика реплики или аукциона.</summary>
public static class ConsumerFailures
{
    private static readonly Meter Meter = new("solguficky.failures");
    private static readonly Counter<long> Failures = Meter.CreateCounter<long>("solguficky.failures");
    public static void Record(string category) => Failures.Add(1,
        new KeyValuePair<string, object?>("service", NotificationsHost.ServiceId),
        new KeyValuePair<string, object?>("error_category", category));
}
