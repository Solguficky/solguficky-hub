using System.Diagnostics.Metrics;

namespace Notifications.Reminders;

/// <summary>Низкокардинальные сигналы прохода и переходов задания начала окна.</summary>
/// <remarks>
/// Мер свой, а не общий с напоминанием о лоте: «сколько заданий сработало»
/// смешало бы дедлайны лотов, сходки и окна, и ни одну из величин нельзя было
/// бы прочитать по её имени. Устройство то же, что у
/// <see cref="LotReminderTelemetry" />.
/// </remarks>
public sealed class StepWindowTelemetry
{
    public const string MeterName = "notifications.step_windows";

    private static readonly Meter Meter = new(MeterName);
    private static readonly Counter<long> SweepTicks = Meter.CreateCounter<long>("notifications.step_window.sweep_ticks");
    private static readonly Gauge<long> LastSuccessfulSweep = Meter.CreateGauge<long>("notifications.step_window.last_successful_sweep_unix_seconds");
    private static readonly Gauge<double> OldestDueAge = Meter.CreateGauge<double>("notifications.step_window.oldest_due_age_seconds");
    private static readonly Counter<long> Scheduled = Meter.CreateCounter<long>("notifications.step_window.scheduled");
    private static readonly Counter<long> Fired = Meter.CreateCounter<long>("notifications.step_window.fired");
    private static readonly Counter<long> Cancelled = Meter.CreateCounter<long>("notifications.step_window.cancelled");

    private long lastSuccessfulSweepUnixSeconds;
    private long scheduledTotal;
    private long firedTotal;
    private long cancelledTotal;

    public long LastSuccessfulSweepUnixSeconds => Interlocked.Read(ref lastSuccessfulSweepUnixSeconds);
    public long ScheduledTotal => Interlocked.Read(ref scheduledTotal);
    public long FiredTotal => Interlocked.Read(ref firedTotal);
    public long CancelledTotal => Interlocked.Read(ref cancelledTotal);

    public void Tick() => SweepTicks.Add(1);

    public void Complete(DateTimeOffset now)
    {
        var completedAt = now.ToUnixTimeSeconds();
        Interlocked.Exchange(ref lastSuccessfulSweepUnixSeconds, completedAt);
        LastSuccessfulSweep.Record(completedAt);
    }

    public void ObserveOldestDue(double seconds) => OldestDueAge.Record(seconds);

    public void Schedule()
    {
        Scheduled.Add(1);
        Interlocked.Increment(ref scheduledTotal);
    }

    public void Fire()
    {
        Fired.Add(1);
        Interlocked.Increment(ref firedTotal);
    }

    /// <summary>Задания, снятые потому, что у их начала не осталось окон (PER-788).</summary>
    public void Cancel(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Cancelled.Add(count);
        Interlocked.Add(ref cancelledTotal, count);
    }
}
