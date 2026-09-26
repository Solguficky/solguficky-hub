using System.Diagnostics;
using Grpc.Core;
using Grpc.Core.Interceptors;
using Notifications.Infrastructure;
using Notifications.Observability;
using Notifications.Replica;

namespace Notifications.Transport;

/// <summary>
/// Транспортная граница сервиса: заполняет каркас записи об операции из
/// docs/standards/observability/logging.md, как интерцепторы Identity и Meetups.
/// </summary>
/// <remarks>
/// Каркас заполняет граница, а не вызываемый код, поэтому запись о вызове
/// рождается здесь и больше нигде. <c>request_id</c> и <c>use_case</c> приходят
/// заголовками <c>x-request-id</c> и <c>x-use-case</c> с края цепочки; граница
/// их не выдумывает и, не получив, опускает. Недоступная база отдаётся клиенту
/// <c>Unavailable</c> раньше его дедлайна (ADR-054), а не <c>Unknown</c> через
/// предел Npgsql.
/// </remarks>
public sealed class BoundaryLogInterceptor(ILogger<BoundaryLogInterceptor> logger) : Interceptor
{
    /// <summary>
    /// Предел совпадает с Meetups: значение приходит недоверенным заголовком, и
    /// слишком длинное трактуется как отсутствующее, а не обрезается.
    /// </summary>
    public const int MaxRequestIdLength = 128;

    public override async Task<TResponse> UnaryServerHandler<TRequest, TResponse>(
        TRequest request,
        ServerCallContext context,
        UnaryServerMethod<TRequest, TResponse> continuation)
    {
        // Проба готовности не начата человеком и идёт каждые несколько секунд:
        // её запись была бы шумом, а не журналом.
        if (IsProbe(context.Method))
        {
            return await continuation(request, context);
        }

        var startedAt = Stopwatch.GetTimestamp();

        try
        {
            var response = await continuation(request, context);
            Write(LogLevel.Information, null, Frame(context, "ok", startedAt, StatusCode.OK));
            return response;
        }

        // Отказ, который сервис объявил сам, — часть контракта, а не сбой
        // сервиса: Warning и без stack.
        catch (RpcException declined)
        {
            var category = DeclaredCategory(declined.StatusCode);
            ReplicaTelemetry.Fail(category);

            var fields = Frame(context, "error", startedAt, declined.StatusCode);
            fields["error_category"] = category;
            fields["error"] = declined.Status.Detail;
            Write(LogLevel.Warning, null, fields);
            throw;
        }

        // Отмена клиентом и истёкший deadline: оба отменяют токен вызова. Клиент,
        // закрывший канал, не должен оставлять в журнале сервиса ошибку. Отмена
        // при живом токене вызова — чужой токен внутри обработчика, клиент
        // получает Unknown, и это неожиданный отказ ниже, а не уход клиента.
        catch (OperationCanceledException) when (context.CancellationToken.IsCancellationRequested)
        {
            if (context.Deadline <= DateTime.UtcNow)
            {
                ReplicaTelemetry.Fail("timeout");

                var fields = Frame(context, "error", startedAt, StatusCode.DeadlineExceeded);
                fields["error_category"] = "timeout";
                Write(LogLevel.Warning, null, fields);
            }
            else
            {
                Write(LogLevel.Warning, null, Frame(context, "error", startedAt, StatusCode.Cancelled));
            }

            throw;
        }

        // Недоступная база — не дефект сервиса и не уход клиента: клиент получает
        // Unavailable раньше своего дедлайна, и повтор позже может пройти (ADR-054).
        // Отказ подключения Npgsql и истёкший таймаут команды по типу неотличимы —
        // оба NpgsqlException с TimeoutException внутри, — и оба идут сюда: первый
        // и есть недоступность, а второй дольше дедлайна клиента. Истёк ли дедлайн
        // к моменту отказа, решает контекст вызова: тогда клиент уже видит свой
        // DeadlineExceeded, и запись называет его.
        catch (Exception storage) when (StorageAvailability.IsUnavailable(storage))
        {
            if (context.Deadline <= DateTime.UtcNow)
            {
                ReplicaTelemetry.Fail("timeout");

                var expired = Frame(context, "error", startedAt, StatusCode.DeadlineExceeded);
                expired["error_category"] = "timeout";
                Write(LogLevel.Warning, null, expired);
                throw;
            }

            // Stack норматив держит для неожиданного отказа, а недоступность
            // ожидаема: запись называет причину текстом, как у Identity.
            ReplicaTelemetry.Fail("dependency_unavailable");

            var fields = Frame(context, "error", startedAt, StatusCode.Unavailable);
            fields["error_category"] = "dependency_unavailable";
            fields["error"] = storage.Message;
            Write(LogLevel.Error, null, fields);
            throw new RpcException(new Status(StatusCode.Unavailable, "storage unavailable", storage));
        }

        // Неожиданный отказ записывает граница, на которой он стал наблюдаемым.
        // Дефект SQL на живом соединении сюда и попадает: недоступностью он не
        // является, и Unavailable пригласил бы повторять детерминированный отказ.
        catch (Exception unexpected)
        {
            var category = unexpected is TimeoutException ? "timeout" : "unexpected";
            ReplicaTelemetry.Fail(category);

            var fields = Frame(context, "error", startedAt, StatusCode.Unknown);
            fields["error_category"] = category;
            fields["error"] = unexpected.Message;
            fields["stack"] = unexpected.StackTrace ?? string.Empty;
            Write(LogLevel.Error, unexpected, fields);
            throw;
        }
    }

    /// <summary>Значение заголовка; пустое и отсутствующее — одно и то же.</summary>
    private static string? Header(ServerCallContext context, string name)
    {
        var value = context.RequestHeaders.GetValue(name);
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static string? RequestId(ServerCallContext context) =>
        Header(context, "x-request-id") is { Length: <= MaxRequestIdLength } value ? value : null;

    private static bool IsProbe(string method) => method.StartsWith("/grpc.health.v1.Health/", StringComparison.Ordinal);

    private static string DeclaredCategory(StatusCode code) => code switch
    {
        StatusCode.PermissionDenied or StatusCode.Unauthenticated => "authorization",
        StatusCode.InvalidArgument
            or StatusCode.FailedPrecondition
            or StatusCode.Aborted
            or StatusCode.AlreadyExists
            or StatusCode.NotFound
            or StatusCode.OutOfRange => "invariant",
        StatusCode.DeadlineExceeded => "timeout",
        StatusCode.Unavailable => "dependency_unavailable",
        _ => "unexpected",
    };

    private static Dictionary<string, object> Frame(
        ServerCallContext context,
        string result,
        long startedAt,
        StatusCode code)
    {
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = context.Method,
            ["result"] = result,
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["grpc_code"] = code.ToString(),
        };

        if (RequestId(context) is { } requestId)
        {
            fields["request_id"] = requestId;
        }

        if (Header(context, "x-use-case") is { } useCase)
        {
            fields["use_case"] = useCase;
        }

        return fields;
    }

    private void Write(LogLevel level, Exception? exception, Dictionary<string, object> fields) =>
        OperationLog.Write(logger, level, exception, fields);
}
