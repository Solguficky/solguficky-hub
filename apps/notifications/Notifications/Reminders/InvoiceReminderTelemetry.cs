using System.Diagnostics.Metrics;

namespace Notifications.Reminders;

/// <summary>Низкокардинальные сигналы прохода и переходов задания счёта.</summary>
/// <remarks>
/// Отдельный счётчик от напоминания о сходке и о лоте намеренно: общей метрики
/// хватило бы, но тогда «сколько напоминаний сработало» смешивало бы сходки,
/// лоты и счета, и ни одну из величин нельзя было бы прочитать по её имени.
/// Мер сам по себе, счётчики свои.
/// </remarks>
public sealed class InvoiceReminderTelemetry
{
    public const string MeterName = "notifications.invoice_reminders";

    private static readonly Meter Meter = new(MeterName);
    private static readonly Counter<long> SweepTicks = Meter.CreateCounter<long>("notifications.invoice_reminder.sweep_ticks");
    private static readonly Gauge<long> LastSuccessfulSweep = Meter.CreateGauge<long>("notifications.invoice_reminder.last_successful_sweep_unix_seconds");
    private static readonly Gauge<double> OldestDueAge = Meter.CreateGauge<double>("notifications.invoice_reminder.oldest_due_age_seconds");
    private static readonly Counter<long> Fired = Meter.CreateCounter<long>("notifications.invoice_reminder.fired");
    private static readonly Counter<long> Removed = Meter.CreateCounter<long>("notifications.invoice_reminder.removed");

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
