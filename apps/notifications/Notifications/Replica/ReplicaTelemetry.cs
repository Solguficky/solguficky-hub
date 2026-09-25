using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Notifications.Replica;

/// <summary>
/// Отставание реплики и исходы применения по каждому источнику.
/// </summary>
/// <remarks>
/// Возраст считается от <c>occurred_at</c> последнего применённого события,
/// то есть от момента коммита у владельца, а не от доставки. Это возраст того,
/// что реплика знает, и в тишине он растёт, хотя отставания нет: отличить одно
/// от другого может только число неподтверждённых сообщений durable, а метрики
/// lag и redelivery шины проектируются вместе с политикой повторов (PER-72).
///
/// Meter создаётся на экземпляр, а не статически, как у
/// <c>ReminderTelemetry</c>: наблюдаемому gauge нужны часы и состояние этого
/// экземпляра, а контейнер разбирает Meter вместе с хостом.
/// </remarks>
public sealed class ReplicaTelemetry : IDisposable
{
    public const string MeterName = "notifications.replica";

    /// <summary>
    /// Метр межсервисного счётчика отказов из docs/standards/observability/logging.md.
    /// ServiceDefaults подписывается на него сам.
    /// </summary>
    public const string FailuresMeterName = "solguficky.failures";

    private static readonly Meter FailuresMeter = new(FailuresMeterName);
    private static readonly Counter<long> Failures = FailuresMeter.CreateCounter<long>(FailuresMeterName);

    private readonly Meter meter = new(MeterName);
    private readonly Counter<long> events;
    private readonly TimeProvider clock;
    private readonly ConcurrentDictionary<string, DateTimeOffset> lastApplied = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<(string Source, string Outcome), long> totals = new();

    public ReplicaTelemetry(TimeProvider clock)
    {
        this.clock = clock;
        events = meter.CreateCounter<long>("notifications.replica.events");
        meter.CreateObservableGauge(
            "notifications.replica.last_applied_age_seconds",
            ObserveAges,
            unit: "s",
            description: "Age of the latest applied event per source, counted from its commit at the owner.");
    }

    /// <summary>Момент коммита самого позднего применённого события источника.</summary>
    public DateTimeOffset? LastAppliedAt(string source) =>
        lastApplied.TryGetValue(source, out var moment) ? moment : null;

    /// <summary>Возраст самого позднего применённого события источника, в секундах.</summary>
    public double? AgeSeconds(string source) =>
        LastAppliedAt(source) is { } moment ? (clock.GetUtcNow() - moment).TotalSeconds : null;

    /// <summary>Сколько сообщений источника закончилось этим исходом с запуска.</summary>
    public long Total(string source, string outcome) =>
        totals.TryGetValue((source, outcome), out var count) ? count : 0;

    /// <summary>
    /// Восстанавливает отметку после рестарта из самой реплики. Более позднюю
    /// уже записанную отметку не затирает.
    /// </summary>
    public void Seed(string source, DateTimeOffset? occurredAt)
    {
        if (occurredAt is { } moment)
        {
            Advance(source, moment);
        }
    }

    /// <summary>Учитывает исход одного сообщения.</summary>
    public void Record(string source, string outcome, DateTimeOffset? appliedOccurredAt = null)
    {
        events.Add(
            1,
            new KeyValuePair<string, object?>("source", source),
            new KeyValuePair<string, object?>("outcome", outcome));
        totals.AddOrUpdate((source, outcome), 1, (_, count) => count + 1);

        if (appliedOccurredAt is { } moment)
        {
            Advance(source, moment);
        }
    }

    /// <summary>Учитывает отказ в межсервисном счётчике по категории норматива.</summary>
    public static void Fail(string errorCategory) =>
        Failures.Add(
            1,
            new KeyValuePair<string, object?>("service", NotificationsHost.ServiceId),
            new KeyValuePair<string, object?>("error_category", errorCategory));

    // Отметка только растёт: события разных агрегатов приходят без общего
    // порядка, и позднее применённое не обязано быть позднее закоммиченным.
    private void Advance(string source, DateTimeOffset moment) =>
        lastApplied.AddOrUpdate(source, moment, (_, held) => moment > held ? moment : held);

    private IEnumerable<Measurement<double>> ObserveAges()
    {
        var now = clock.GetUtcNow();

        foreach (var (source, moment) in lastApplied)
        {
            yield return new Measurement<double>(
                (now - moment).TotalSeconds,
                new KeyValuePair<string, object?>("source", source));
        }
    }

    public void Dispose() => meter.Dispose();
}
