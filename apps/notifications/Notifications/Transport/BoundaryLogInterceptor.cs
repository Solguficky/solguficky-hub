using System.Diagnostics;
using Grpc.Core;
using Grpc.Core.Interceptors;
using Notifications.Infrastructure;
using Notifications.Replica;

namespace Notifications.Transport;

/// <summary>
/// Транспортная граница сервиса: заполняет каркас записи об операции из
/// docs/standards/observability/logging.md. Запись рождается здесь и больше
/// нигде.
/// </summary>
/// <remarks>
/// Форма повторяет границу Meetups, и поля пишутся именованными местами шаблона,
/// а не JSON-строкой в теле: иначе фильтр structured logs по
/// <c>error_category</c> и <c>request_id</c> запись не найдёт. Недоступная база
/// отдаётся клиенту <c>Unavailable</c> раньше его дедлайна (ADR-054), а не
/// <c>Unknown</c> через предел Npgsql.
/// </remarks>
public sealed class BoundaryLogInterceptor(ILogger<BoundaryLogInterceptor> logger) : Interceptor
{
    /// <summary>
    /// Предел <c>request_id</c> совпадает с пределом соседей: значение, которое
    /// одна граница приняла, приняла бы и другая.
    /// </summary>
    private const int RequestIdMaxLength = 128;

    public override async Task<TResponse> UnaryServerHandler<TRequest, TResponse>(
        TRequest request,
        ServerCallContext context,
        UnaryServerMethod<TRequest, TResponse> continuation)
    {
        // Проба готовности не начата человеком и сценария не имеет. Она идёт
        // каждые несколько секунд, поэтому её запись была бы шумом, а не журналом.
        if (context.Method.StartsWith("/grpc.health.v1.Health/", StringComparison.Ordinal))
        {
            return await continuation(request, context);
        }

        var started = Stopwatch.GetTimestamp();

        try
        {
            var response = await continuation(request, context);
            Write(LogLevel.Information, null, Frame(context, "ok", started, StatusCode.OK));
            return response;
        }
        // Отказ, который сервис объявил сам, — часть контракта, а не сбой:
        // Warning и никакого stack.
        catch (RpcException declined)
        {
            var category = DeclaredCategory(declined.StatusCode);
            ReplicaTelemetry.Fail(category);
            Write(
                LogLevel.Warning,
                null,
                Frame(context, "error", started, declined.StatusCode,
                    ("error_category", category),
                    ("error", declined.Status.Detail)));
            throw;
        }
        // Отмена клиентом и истёкший дедлайн. Клиент, закрывший канал, не должен
        // оставлять в журнале сервиса ошибку.
        catch (OperationCanceledException)
        {
            WriteCancellation(context, started);
            throw;
        }
        catch (Exception storage) when (StorageAvailability.IsUnavailable(storage))
        {
            // Истёк дедлайн вызова — клиент уже видит свой DeadlineExceeded, и
            // запись называет его, а не Unavailable, ушедший в закрытый поток.
            if (Expired(context))
            {
                WriteCancellation(context, started);
                throw;
            }

            // Stack норматив держит для неожиданного отказа, а недоступность
            // ожидаема: запись называет причину текстом, как у Identity.
            ReplicaTelemetry.Fail("dependency_unavailable");
            Write(
                LogLevel.Error,
                null,
                Frame(context, "error", started, StatusCode.Unavailable,
                    ("error_category", "dependency_unavailable"),
                    ("error", storage.Message)));
            throw new RpcException(new Status(StatusCode.Unavailable, "storage unavailable", storage));
        }
        // Неожиданный отказ записывает та граница, на которой он стал наблюдаемым.
        catch (Exception unexpected)
        {
            var category = unexpected is TimeoutException ? "timeout" : "unexpected";
            ReplicaTelemetry.Fail(category);
            Write(
                LogLevel.Error,
                unexpected,
                Frame(context, "error", started, StatusCode.Unknown,
                    ("error_category", category),
                    ("error", unexpected.Message),
                    ("stack", unexpected.StackTrace)));
            throw;
        }
    }

    private static bool Expired(ServerCallContext context) => context.Deadline <= DateTime.UtcNow;

    private void WriteCancellation(ServerCallContext context, long started)
    {
        if (Expired(context))
        {
            ReplicaTelemetry.Fail("timeout");
            Write(
                LogLevel.Warning,
                null,
                Frame(context, "error", started, StatusCode.DeadlineExceeded, ("error_category", "timeout")));
        }
        else
        {
            Write(LogLevel.Warning, null, Frame(context, "error", started, StatusCode.Cancelled));
        }
    }

    private static string DeclaredCategory(StatusCode code) =>
        code switch
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

    private static List<(string Name, object? Value)> Frame(
        ServerCallContext context,
        string result,
        long started,
        StatusCode code,
        params (string Name, object? Value)[] extras)
    {
        var fields = new List<(string Name, object? Value)>
        {
            ("service", NotificationsHost.ServiceId),
            ("operation", context.Method),
            ("result", result),
            ("duration_us", (long)Stopwatch.GetElapsedTime(started).TotalMicroseconds),
            ("grpc_code", code.ToString()),
        };

        // Пустой заголовок не превращается в значение: logging.md требует опускать
        // то, что граница не получила. Слишком длинный id отбрасывается так же.
        if (Header(context, "x-request-id") is { Length: <= RequestIdMaxLength } requestId)
        {
            fields.Add(("request_id", requestId));
        }

        if (Header(context, "x-use-case") is { } useCase)
        {
            fields.Add(("use_case", useCase));
        }

        fields.AddRange(extras);
        return fields;
    }

    private static string? Header(ServerCallContext context, string name) =>
        context.RequestHeaders
            .FirstOrDefault(entry =>
                string.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(entry.Value))
            ?.Value;

    private void Write(LogLevel level, Exception? error, List<(string Name, object? Value)> fields)
    {
        // Шаблон собирается из имён полей: каждое поле становится именованным
        // местом, и структурный лог получает его атрибутом, а не строкой в теле.
#pragma warning disable CA2254 // Шаблон стабилен по составу полей, а не константа.
        logger.Log(
            level,
            error,
            "gRPC boundary " + string.Join(" ", fields.Select(field => "{" + field.Name + "}")),
            fields.Select(field => field.Value).ToArray());
#pragma warning restore CA2254
    }
}
