using System.Text.Json;
using Microsoft.Extensions.Logging;
using Notifications.Observability;
using Notifications.UnitTests.TestUtilities;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ObservabilityTests;

public class OperationLogTests
{
    [Fact]
    public void Write_Fields_EachFieldIsAnAttribute()
    {
        // Фильтр по полю в dashboard ищет атрибут: поле, лежащее только в теле,
        // он не находит (PER-363).
        var logger = new RecordingLogger<OperationLogTests>();

        OperationLog.Write(logger, LogLevel.Information, null, new Dictionary<string, object>
        {
            ["operation"] = "reminder_sweep",
            ["request_id"] = "req-1",
            ["due_count"] = 3,
        });

        var record = logger.Records.ShouldHaveSingleItem();
        record.Attributes["operation"].ShouldBe("reminder_sweep");
        record.Attributes["request_id"].ShouldBe("req-1");
        record.Attributes["due_count"].ShouldBe(3);
    }

    [Fact]
    public void Write_Fields_BodyIsTheSameFieldsAsJson()
    {
        // Панели infra/observability/ читают тело через | json: оно не должно
        // измениться от того, что поля стали ещё и атрибутами.
        var logger = new RecordingLogger<OperationLogTests>();
        var fields = new Dictionary<string, object>
        {
            ["operation"] = "reminder_sweep",
            ["fired_total"] = 7L,
            ["oldest_due_age_seconds"] = 1.5,
        };

        OperationLog.Write(logger, LogLevel.Information, null, fields);

        logger.Records.ShouldHaveSingleItem().Body.ShouldBe(JsonSerializer.Serialize(fields));
    }

    [Fact]
    public void Write_Exception_PassesItToTheProvider()
    {
        var logger = new RecordingLogger<OperationLogTests>();
        var failure = new InvalidOperationException("boom");

        OperationLog.Write(logger, LogLevel.Error, failure, new Dictionary<string, object> { ["result"] = "error" });

        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Error);
        record.Exception.ShouldBeSameAs(failure);
    }
}
