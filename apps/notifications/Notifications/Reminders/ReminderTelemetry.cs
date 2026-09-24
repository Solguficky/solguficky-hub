using System.Diagnostics.Metrics;

namespace Notifications.Reminders;

/// <summary>Низкокардинальные сигналы прохода и переходов задания.</summary>
public sealed class ReminderTelemetry
{
    public const string MeterName = "notifications.reminders";

    private static readonly Meter Meter = new(MeterName);
    private static readonly Counter<long> SweepTicks = Meter.CreateCounter<long>("notifications.reminder.sweep_ticks");
    private static readonly Gauge<long> LastSuccessfulSweep = Meter.CreateGauge<long>("notifications.reminder.last_successful_sweep_unix_seconds");
    private static readonly Gauge<double> OldestDueAge = Meter.CreateGauge<double>("notifications.reminder.oldest_due_age_seconds");
    private static readonly Counter<long> Fired = Meter.CreateCounter<long>("notifications.reminder.fired");
    private static readonly Counter<long> Removed = Meter.CreateCounter<long>("notifications.reminder.removed");

    private long lastSuccessfulSweepUnixSeconds;
    private long firedTotal;
    private long removedTotal;

    public long LastSuccessfulSweepUnixSeconds => Interlocked.Read(ref lastSuccessfulSweepUnixSeconds);
    public long FiredTotal => Interlocked.Read(ref firedTotal);
    public long RemovedTotal => Interlocked.Read(ref removedTotal);

    public void Tick() => SweepTicks.Add(1);

    public void Complete(DateTimeOffset now)
    {
        var completedAt = now.ToUnixTimeSeconds();
        Interlocked.Exchange(ref lastSuccessfulSweepUnixSeconds, completedAt);
        LastSuccessfulSweep.Record(completedAt);
    }

    public void ObserveOldestDue(double seconds) => OldestDueAge.Record(seconds);

    public void Fire()
    {
        Fired.Add(1);
        Interlocked.Increment(ref firedTotal);
    }

    public void Remove(long count, string reason)
    {
        if (count == 0)
        {
            return;
        }

        Removed.Add(count, new KeyValuePair<string, object?>("reason", reason));
        Interlocked.Add(ref removedTotal, count);
    }
}
