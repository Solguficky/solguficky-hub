using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Notifications.Facts;

/// <summary>
/// Низкокардинальные сигналы адресных фактов: сколько порождено, сколько
/// отсечено настройками, сколько снято до выноса и как идёт вынос в шину.
/// </summary>
/// <remarks>
/// Разбивка на один повод живёт не здесь, а в записи <c>replica_apply</c> того
/// события, которое повод породило (<c>facts_created</c>,
/// <c>facts_suppressed</c>): идентификатор события в метку метрики не
/// кладётся, кардинальность росла бы с каждым поводом.
/// </remarks>
public sealed class FactTelemetry
{
    public const string MeterName = "notifications.facts";

    private static readonly Meter Meter = new(MeterName);
    private static readonly Counter<long> Created = Meter.CreateCounter<long>("notifications.facts.created");
    private static readonly Counter<long> Suppressed = Meter.CreateCounter<long>("notifications.facts.suppressed");
    private static readonly Counter<long> Withdrawn = Meter.CreateCounter<long>("notifications.facts.withdrawn");
    private static readonly Counter<long> Dispatched = Meter.CreateCounter<long>("notifications.facts.dispatched");
    private static readonly Counter<long> DispatchFailures = Meter.CreateCounter<long>("notifications.facts.dispatch_failures");
    private static readonly Gauge<double> OldestPendingAge = Meter.CreateGauge<double>(
        "notifications.facts.oldest_pending_age_seconds",
        unit: "s",
        description: "Age of the oldest fact not yet confirmed by the bus, measured after each relay pass.");

    private readonly ConcurrentDictionary<string, long> totals = new(StringComparer.Ordinal);

    /// <summary>Сколько раз с запуска случилось событие с этим именем.</summary>
    public long Total(string name) => totals.TryGetValue(name, out var count) ? count : 0;

    /// <summary>Учитывает разворот одного повода.</summary>
    public void Record(string type, FactCount facts)
    {
        var tag = new KeyValuePair<string, object?>("type", type);

        if (facts.Created > 0)
        {
            Created.Add(facts.Created, tag);
            Add("created", facts.Created);
        }

        if (facts.Suppressed > 0)
        {
            // Единственная причина отсечения в этом срезе — настройка категории.
            // Заблокированный и человек вне круга хаба адресатами не считаются
            // вовсе, а не отсекаются: им факт не был положен.
            Suppressed.Add(facts.Suppressed, tag, new KeyValuePair<string, object?>("reason", "preference"));
            Add("suppressed", facts.Suppressed);
        }
    }

    /// <summary>
    /// Учитывает факты, снятые до выноса в шину. Отдельный счётчик, а не
    /// разновидность отказа: снятый факт не потерян, его не нужно было
    /// доставлять.
    /// </summary>
    /// <param name="reason">Причина из <c>notification.withdrawal_reason</c>.</param>
    public void RecordWithdrawn(string reason, IReadOnlyList<WithdrawnFacts> withdrawn)
    {
        foreach (var facts in withdrawn)
        {
            Withdrawn.Add(
                facts.Count,
                new KeyValuePair<string, object?>("type", facts.Type),
                new KeyValuePair<string, object?>("reason", reason));
            Add("withdrawn", facts.Count);
        }
    }

    public void Dispatch(int count)
    {
        if (count == 0)
        {
            return;
        }

        Dispatched.Add(count);
        Add("dispatched", count);
    }

    public void DispatchFailed()
    {
        DispatchFailures.Add(1);
        Add("dispatch_failures", 1);
    }

    public void ObserveOldestPending(double seconds) => OldestPendingAge.Record(seconds);

    private void Add(string name, long count) => totals.AddOrUpdate(name, count, (_, held) => held + count);
}
