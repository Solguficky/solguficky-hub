using Grpc.Core;
using Microsoft.Extensions.Logging;
using Npgsql;
using Notifications.Transport;
using Notifications.UnitTests.TestUtilities;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.TransportTests;

public class BoundaryLogInterceptorTests
{
    private const string Product = "/notifications.v1.NotificationsService/GetGlobalNotificationPreferences";

    [Fact]
    public async Task UnaryServerHandler_CallWithMetadata_RecordsRequestIdAndUseCase()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product, ("x-request-id", "req-bot-frame"), ("x-use-case", "view_meetup"));

        await interceptor.UnaryServerHandler("request", context, (_, _) => Task.FromResult("answer"));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Information);
        record.Attributes["service"].ShouldBe(NotificationsHost.ServiceId);
        record.Attributes["operation"].ShouldBe(Product);
        record.Attributes["result"].ShouldBe("ok");
        record.Attributes["grpc_code"].ShouldBe("OK");
        record.Attributes["request_id"].ShouldBe("req-bot-frame");
        record.Attributes["use_case"].ShouldBe("view_meetup");
        record.Attributes.ShouldContainKey("duration_us");
    }

    [Fact]
    public async Task UnaryServerHandler_CallWithoutMetadata_OmitsRequestIdAndUseCase()
    {
        // Поле, которое граница не получила, опускается, а не пишется пустым.
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product, ("x-request-id", " "));

        await interceptor.UnaryServerHandler("request", context, (_, _) => Task.FromResult("answer"));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Attributes["operation"].ShouldBe(Product);
        record.Attributes.ShouldNotContainKey("request_id");
        record.Attributes.ShouldNotContainKey("use_case");
    }

    [Fact]
    public async Task UnaryServerHandler_RequestIdOverLimit_OmitsIt()
    {
        var (logger, interceptor) = Create();
        var tooLong = new string('r', BoundaryLogInterceptor.MaxRequestIdLength + 1);
        var context = new FakeServerCallContext(Product, ("x-request-id", tooLong));

        await interceptor.UnaryServerHandler("request", context, (_, _) => Task.FromResult("answer"));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Attributes["operation"].ShouldBe(Product);
        record.Attributes.ShouldNotContainKey("request_id");
    }

    [Fact]
    public async Task UnaryServerHandler_DeclaredRefusal_RecordsWarningAndRethrows()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product, ("x-request-id", "req-1"));
        var refusal = new RpcException(new Status(StatusCode.InvalidArgument, "identity_id: must be a UUIDv7"));

        var thrown = await Should.ThrowAsync<RpcException>(
            () => interceptor.UnaryServerHandler<string, string>("request", context, (_, _) => throw refusal));

        thrown.ShouldBeSameAs(refusal);
        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Warning);
        record.Exception.ShouldBeNull();
        record.Attributes["result"].ShouldBe("error");
        record.Attributes["grpc_code"].ShouldBe("InvalidArgument");
        record.Attributes["error_category"].ShouldBe("invariant");
        record.Attributes["error"].ShouldBe("identity_id: must be a UUIDv7");
        record.Attributes["request_id"].ShouldBe("req-1");
        record.Attributes.ShouldNotContainKey("stack");
    }

    [Fact]
    public async Task UnaryServerHandler_UnexpectedFailure_RecordsErrorWithStack()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product);

        await Should.ThrowAsync<InvalidOperationException>(
            () => interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => throw new InvalidOperationException("boom")));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Error);
        record.Exception.ShouldBeOfType<InvalidOperationException>();
        record.Attributes["grpc_code"].ShouldBe("Unknown");
        record.Attributes["error_category"].ShouldBe("unexpected");
        record.Attributes["error"].ShouldBe("boom");
        record.Attributes.ShouldContainKey("stack");
    }

    [Fact]
    public async Task UnaryServerHandler_CancellationWithLiveCallToken_RecordsUnexpectedFailure()
    {
        // Токен вызова жив, значит клиент не уходил: отмена пришла изнутри
        // обработчика, и клиент получит Unknown, а не Cancelled.
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product);

        await Should.ThrowAsync<OperationCanceledException>(
            () => interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => throw new OperationCanceledException()));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Error);
        record.Attributes["grpc_code"].ShouldBe("Unknown");
        record.Attributes["error_category"].ShouldBe("unexpected");
    }

    [Fact]
    public async Task UnaryServerHandler_ClientCancelled_RecordsCancelledWithoutCategory()
    {
        var (logger, interceptor) = Create();
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        var context = new FakeServerCallContext(Product, cancelled.Token);

        await Should.ThrowAsync<OperationCanceledException>(
            () => interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => throw new OperationCanceledException(cancelled.Token)));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Warning);
        record.Attributes["grpc_code"].ShouldBe("Cancelled");
        record.Attributes.ShouldNotContainKey("error_category");
    }

    /// <summary>
    /// Недоступная база отдаётся Unavailable раньше дедлайна клиента (ADR-054).
    /// Отказ подключения Npgsql приходит NpgsqlException с TimeoutException
    /// внутри — так выглядит остановленный PostgreSQL за прокси DCP.
    /// </summary>
    [Fact]
    public async Task UnaryServerHandler_UnreachableDatabase_RefusesWithUnavailable()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product);

        var thrown = await Should.ThrowAsync<RpcException>(
            () => interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => throw new NpgsqlException("The operation has timed out", new TimeoutException())));

        thrown.StatusCode.ShouldBe(StatusCode.Unavailable);
        var record = logger.Records.ShouldHaveSingleItem();
        record.Level.ShouldBe(LogLevel.Error);
        record.Exception.ShouldBeNull();
        record.Attributes["grpc_code"].ShouldBe("Unavailable");
        record.Attributes["error_category"].ShouldBe("dependency_unavailable");
        record.Attributes.ShouldNotContainKey("stack");
    }

    /// <summary>
    /// Ответ живого сервера на дефект SQL недоступностью не считается: Unavailable
    /// пригласил бы повторять отказ, который повторится детерминированно.
    /// </summary>
    [Fact]
    public async Task UnaryServerHandler_SqlDefect_RecordsUnexpectedFailure()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product);
        var defect = new PostgresException("duplicate key", "ERROR", "ERROR", "23505");

        var thrown = await Should.ThrowAsync<PostgresException>(
            () => interceptor.UnaryServerHandler<string, string>("request", context, (_, _) => throw defect));

        thrown.ShouldBeSameAs(defect);
        var record = logger.Records.ShouldHaveSingleItem();
        record.Attributes["grpc_code"].ShouldBe("Unknown");
        record.Attributes["error_category"].ShouldBe("unexpected");
    }

    /// <summary>
    /// Отказ базы после истечения дедлайна — timeout: клиент уже видит свой
    /// DeadlineExceeded, и запись называет его, а не Unavailable.
    /// </summary>
    [Fact]
    public async Task UnaryServerHandler_UnreachableDatabaseAfterDeadline_RecordsTimeout()
    {
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext(Product) { DeadlineAt = DateTime.UtcNow.AddSeconds(-1) };

        await Should.ThrowAsync<NpgsqlException>(
            () => interceptor.UnaryServerHandler<string, string>(
                "request",
                context,
                (_, _) => throw new NpgsqlException("The operation has timed out", new TimeoutException())));

        var record = logger.Records.ShouldHaveSingleItem();
        record.Attributes["grpc_code"].ShouldBe("DeadlineExceeded");
        record.Attributes["error_category"].ShouldBe("timeout");
    }

    [Fact]
    public async Task UnaryServerHandler_HealthProbe_LeavesNoRecord()
    {
        // Проба идёт каждые несколько секунд и сценария не имеет.
        var (logger, interceptor) = Create();
        var context = new FakeServerCallContext("/grpc.health.v1.Health/Check");

        await interceptor.UnaryServerHandler("request", context, (_, _) => Task.FromResult("answer"));

        logger.Records.ShouldBeEmpty();
    }

    private static (RecordingLogger<BoundaryLogInterceptor> Logger, BoundaryLogInterceptor Interceptor) Create()
    {
        var logger = new RecordingLogger<BoundaryLogInterceptor>();
        return (logger, new BoundaryLogInterceptor(logger));
    }

    private sealed class FakeServerCallContext(
        string method,
        CancellationToken cancellationToken,
        params (string Key, string Value)[] headers)
        : ServerCallContext
    {
        public FakeServerCallContext(string method, params (string Key, string Value)[] headers)
            : this(method, CancellationToken.None, headers)
        {
        }

        private readonly Metadata requestHeaders = Build(headers);

        protected override string MethodCore => method;

        protected override string HostCore => "localhost";

        protected override string PeerCore => "ipv4:127.0.0.1:50000";

        /// <summary>Дедлайн вызова; по умолчанию его нет.</summary>
        public DateTime DeadlineAt { get; init; } = DateTime.MaxValue;

        protected override DateTime DeadlineCore => DeadlineAt;

        protected override Metadata RequestHeadersCore => requestHeaders;

        protected override CancellationToken CancellationTokenCore => cancellationToken;

        protected override Metadata ResponseTrailersCore { get; } = [];

        protected override Status StatusCore { get; set; }

        protected override WriteOptions? WriteOptionsCore { get; set; }

        protected override AuthContext AuthContextCore { get; } = new(null, []);

        protected override ContextPropagationToken CreatePropagationTokenCore(ContextPropagationOptions? options) =>
            throw new NotSupportedException();

        protected override Task WriteResponseHeadersAsyncCore(Metadata responseHeaders) => Task.CompletedTask;

        private static Metadata Build((string Key, string Value)[] headers)
        {
            var metadata = new Metadata();
            foreach (var (key, value) in headers)
            {
                metadata.Add(key, value);
            }

            return metadata;
        }
    }
}
