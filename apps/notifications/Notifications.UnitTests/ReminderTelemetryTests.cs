using System.Diagnostics.Metrics;
using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

public class ReminderTelemetryTests
{
    [Fact]
    public void When_SweepCompletes_Expect_LastSuccessAndOldestDueAgeRecorded()
    {
        var values = new Dictionary<string, double>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == ReminderTelemetry.MeterName)
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, measurement, _, _) =>
            values[instrument.Name] = measurement);
        listener.SetMeasurementEventCallback<double>((instrument, measurement, _, _) =>
            values[instrument.Name] = measurement);
        listener.Start();

        var telemetry = new ReminderTelemetry();
        var now = new DateTimeOffset(2026, 9, 24, 10, 0, 0, TimeSpan.Zero);

        telemetry.Tick();
        telemetry.ObserveOldestDue(42.5);
        telemetry.Complete(now);

        telemetry.LastSuccessfulSweepUnixSeconds.ShouldBe(now.ToUnixTimeSeconds());
        values["notifications.reminder.sweep_ticks"].ShouldBe(1);
        values["notifications.reminder.last_successful_sweep_unix_seconds"].ShouldBe(now.ToUnixTimeSeconds());
        values["notifications.reminder.oldest_due_age_seconds"].ShouldBe(42.5);
    }

    [Fact]
    public void When_TasksFireOrAreRemoved_Expect_DistinctCommittedCounts()
    {
        var telemetry = new ReminderTelemetry();

        telemetry.Fire();
        telemetry.Remove(1, "cancelled");
        telemetry.Remove(2, "superseded");
        telemetry.Remove(0, "cancelled");

        telemetry.FiredTotal.ShouldBe(1);
        telemetry.RemovedTotal.ShouldBe(3);
        telemetry.LastSuccessfulSweepUnixSeconds.ShouldBe(0);
    }
}
