using Grpc.Core;
using Microsoft.Extensions.Logging;
using Notifications.Transport;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.TransportTests;

/// <summary>
/// Граница записывает каждый вызов один раз, полями, а не строкой, и отдаёт
/// недоступную базу клиенту кодом <c>Unavailable</c>.
/// </summary>
public class BoundaryLogInterceptorTests
{
    private const string Product = "/notifications.v1.NotificationsService/GetGlobalNotificationPreferences";

    [Fact]
    public async Task Intercept_UnreachableDatabase_Expect_UnavailableAndDependencyUnavailableRecord()
    {
        var (records, thrown) = await Intercept(
            new FakeServerCallContext(Product),
            () => throw new NpgsqlException("Failed to connect to 127.0.0.1:1"));

        var record = records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Error);
        record.Fields["grpc_code"].ShouldBe("Unavailable");
        record.Fields["error_category"].ShouldBe("dependency_unavailable");
        record.Fields.ContainsKey("stack").ShouldBeFalse();
        thrown.ShouldBeOfType<RpcException>().StatusCode.ShouldBe(StatusCode.Unavailable);
    }

    [Fact]
    public async Task Intercept_SqlDefect_Expect_UnexpectedFailureRethrown()
    {
        var defect = new PostgresException("duplicate key", "ERROR", "ERROR", "23505");

        var (records, thrown) = await Intercept(new FakeServerCallContext(Product), () => throw defect);

        var record = records.ShouldHaveSingleItem();
        record.Fields["grpc_code"].ShouldBe("Unknown");
        record.Fields["error_category"].ShouldBe("unexpected");
        thrown.ShouldBeSameAs(defect);
    }

    [Fact]
    public async Task Intercept_UnreachableDatabaseAfterDeadline_Expect_TimeoutRecord()
    {
        var context = new FakeServerCallContext(Product, deadline: DateTime.UtcNow.AddSeconds(-1));

        var (records, _) = await Intercept(context, () => throw new NpgsqlException("timeout"));

        var record = records.ShouldHaveSingleItem();
        record.Fields["grpc_code"].ShouldBe("DeadlineExceeded");
        record.Fields["error_category"].ShouldBe("timeout");
    }

    [Fact]
    public async Task Intercept_DeclaredRefusal_Expect_WarningWithoutStack()
    {
        var (records, thrown) = await Intercept(
            new FakeServerCallContext(Product),
            () => throw new RpcException(new Status(StatusCode.InvalidArgument, "identity_id is not a UUIDv7")));

        var record = records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Warning);
        record.Fields["error_category"].ShouldBe("invariant");
        record.Fields.ContainsKey("stack").ShouldBeFalse();
        thrown.ShouldBeOfType<RpcException>().StatusCode.ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public async Task Intercept_Success_Expect_StructuredFrameWithRequestId()
    {
        var headers = new Metadata { { "x-request-id", "request-42" }, { "x-use-case", "open_settings" } };

        var (records, thrown) = await Intercept(new FakeServerCallContext(Product, headers: headers), () => "ok");

        thrown.ShouldBeNull();
        var record = records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Information);
        record.Fields["service"].ShouldBe("notifications");
        record.Fields["operation"].ShouldBe(Product);
        record.Fields["result"].ShouldBe("ok");
        record.Fields["grpc_code"].ShouldBe("OK");
        record.Fields["request_id"].ShouldBe("request-42");
        record.Fields["use_case"].ShouldBe("open_settings");
    }

    [Fact]
    public async Task Intercept_ReadinessProbe_Expect_NoRecord()
    {
        var (records, _) = await Intercept(new FakeServerCallContext("/grpc.health.v1.Health/Check"), () => "serving");

        records.ShouldBeEmpty();
    }

    private static async Task<(List<Record> Records, Exception? Thrown)> Intercept(
        ServerCallContext context,
        Func<string> continuation)
    {
        var logger = new RecordingLogger();
        var interceptor = new BoundaryLogInterceptor(logger);

        try
        {
            await interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => Task.FromResult(continuation()));
            return (logger.Records, null);
        }
        catch (Exception thrown)
        {
            return (logger.Records, thrown);
        }
    }

    private sealed record Record(LogLevel Level, IReadOnlyDictionary<string, object?> Fields);

    /// <summary>
    /// Снимает поля записи так, как их увидит структурный лог: именованными
    /// значениями шаблона, а не текстом сообщения.
    /// </summary>
    private sealed class RecordingLogger : ILogger<BoundaryLogInterceptor>
    {
        public List<Record> Records { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var fields = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (state is IEnumerable<KeyValuePair<string, object?>> values)
            {
                foreach (var (key, value) in values)
                {
                    fields[key] = value;
                }
            }

            Records.Add(new Record(logLevel, fields));
        }
    }

    private sealed class FakeServerCallContext(
        string method,
        DateTime? deadline = null,
        Metadata? headers = null) : ServerCallContext
    {
        protected override string MethodCore => method;
        protected override string HostCore => "localhost";
        protected override string PeerCore => "ipv4:127.0.0.1:0";
        protected override DateTime DeadlineCore { get; } = deadline ?? DateTime.UtcNow.AddMinutes(1);
        protected override Metadata RequestHeadersCore { get; } = headers ?? [];
        protected override CancellationToken CancellationTokenCore => CancellationToken.None;
        protected override Metadata ResponseTrailersCore { get; } = [];
        protected override Status StatusCore { get; set; }
        protected override WriteOptions? WriteOptionsCore { get; set; }
        protected override AuthContext AuthContextCore => new(null, []);

        protected override Task WriteResponseHeadersAsyncCore(Metadata responseHeaders) => Task.CompletedTask;

        protected override ContextPropagationToken CreatePropagationTokenCore(ContextPropagationOptions? options) =>
            throw new NotSupportedException();
    }
}
