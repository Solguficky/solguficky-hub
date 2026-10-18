using System.Diagnostics.Metrics;
using Notifications.Replica;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReplicaTests;

public class ReplicaTelemetryTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Record_AppliedEvent_ExposesAgePerSource()
    {
        var ages = new Dictionary<string, double>();
        using var telemetry = new ReplicaTelemetry(new FixedClock(Now));
        using var listener = Listen(ages);

        telemetry.Record(ReplicaFeeds.MeetupsSource, "applied", Now.AddSeconds(-90));
        telemetry.Record(ReplicaFeeds.IdentitySource, "applied", Now.AddSeconds(-5));
        listener.RecordObservableInstruments();

        ages[ReplicaFeeds.MeetupsSource].ShouldBe(90);
        ages[ReplicaFeeds.IdentitySource].ShouldBe(5);
        telemetry.Total(ReplicaFeeds.MeetupsSource, "applied").ShouldBe(1);
    }

    [Fact]
    public void Record_EarlierCommitAppliedLater_KeepsLatestMoment()
    {
        // События разных сходок идут без общего порядка: применённое позже
        // может быть закоммичено раньше, и отметка назад не уходит.
        using var telemetry = new ReplicaTelemetry(new FixedClock(Now));

        telemetry.Record(ReplicaFeeds.MeetupsSource, "applied", Now.AddMinutes(-1));
        telemetry.Record(ReplicaFeeds.MeetupsSource, "applied", Now.AddMinutes(-10));

        telemetry.LastAppliedAt(ReplicaFeeds.MeetupsSource).ShouldBe(Now.AddMinutes(-1));
    }

    [Fact]
    public void Record_OutcomeWithoutApplication_LeavesAgeUnknown()
    {
        using var telemetry = new ReplicaTelemetry(new FixedClock(Now));

        telemetry.Record(ReplicaFeeds.IdentitySource, "poison");

        telemetry.AgeSeconds(ReplicaFeeds.IdentitySource).ShouldBeNull();
        telemetry.Total(ReplicaFeeds.IdentitySource, "poison").ShouldBe(1);
    }

    [Fact]
    public void Seed_ReplicaHasRows_RestoresAgeAfterRestart()
    {
        using var telemetry = new ReplicaTelemetry(new FixedClock(Now));

        telemetry.Seed(ReplicaFeeds.MeetupsSource, Now.AddHours(-2));
        telemetry.Seed(ReplicaFeeds.IdentitySource, null);

        telemetry.AgeSeconds(ReplicaFeeds.MeetupsSource).ShouldBe(7200);
        telemetry.AgeSeconds(ReplicaFeeds.IdentitySource).ShouldBeNull();
    }

    private static MeterListener Listen(Dictionary<string, double> ages)
    {
        var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == ReplicaTelemetry.MeterName)
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<double>((instrument, measurement, tags, _) =>
        {
            if (instrument.Name == "notifications.replica.last_applied_age_seconds")
            {
                foreach (var tag in tags)
                {
                    if (tag.Key == "source")
                    {
                        ages[(string)tag.Value!] = measurement;
                    }
                }
            }
        });
        listener.Start();
        return listener;
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
