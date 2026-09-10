namespace Meetups.Observability

open System
open System.Diagnostics
open System.Runtime.ExceptionServices
open System.Threading.Tasks
open Grpc.Core
open Grpc.Core.Interceptors
open Microsoft.Extensions.Logging

/// Транспортная граница сервиса: заполняет каркас записи об операции из
/// docs/standards/observability/logging.md. Каркас заполняет граница, а не
/// вызываемый код, поэтому запись рождается здесь и больше нигде.
type BoundaryLogInterceptor(logger: ILogger<BoundaryLogInterceptor>) =
    inherit Interceptor()

    /// Имя сервиса — константа его сборки, а не метка сборщика логов:
    /// значение внутри записи переживает смену транспорта доставки.
    static let service = "meetups"

    /// Проба готовности не начата человеком и сценария не имеет. Она идёт
    /// каждые несколько секунд, поэтому её запись была бы шумом, а не журналом.
    static let isProbe (method: string) = method.StartsWith "/grpc.health.v1.Health/"

    /// Идентификатор рождается на Telegram-краю и приходит транспортными
    /// метаданными. Пустой заголовок не превращается в структурное поле:
    /// logging.md требует опускать значение, которое граница не получила.
    static let requestId (context: ServerCallContext) =
        context.RequestHeaders
        |> Seq.tryPick (fun entry ->
            if
                String.Equals(entry.Key, "x-request-id", StringComparison.OrdinalIgnoreCase)
                && not (String.IsNullOrWhiteSpace entry.Value)
            then
                Some entry.Value
            else
                None)

    /// reraise() внутри task недоступен: он разрешён только прямо в with-блоке.
    /// Capture().Throw() сохраняет исходный stack.
    static let rethrow (exn: exn) = ExceptionDispatchInfo.Capture(exn).Throw()

    override _.UnaryServerHandler<'TRequest, 'TResponse when 'TRequest: not struct and 'TResponse: not struct>
        (request: 'TRequest, context: ServerCallContext, continuation: UnaryServerMethod<'TRequest, 'TResponse>)
        : Task<'TResponse> =
        if isProbe context.Method then
            continuation.Invoke(request, context)
        else
            task {
                let started = Stopwatch.GetTimestamp()
                let elapsedMicroseconds () = int64 (Stopwatch.GetElapsedTime started).TotalMicroseconds
                let requestId = requestId context

                try
                    let! response = continuation.Invoke(request, context)

                    match requestId with
                    | Some id ->
                        logger.LogInformation(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {request_id}",
                            service,
                            context.Method,
                            "ok",
                            elapsedMicroseconds (),
                            string StatusCode.OK,
                            id
                        )
                    | None ->
                        logger.LogInformation(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code}",
                            service,
                            context.Method,
                            "ok",
                            elapsedMicroseconds (),
                            string StatusCode.OK
                        )

                    return response
                with
                // Отказ, который сервис объявил сам, — часть контракта, а не сбой
                // сервиса. Уровень Warning и никакого stack: норматив держит stack
                // для неожиданного отказа.
                | :? RpcException as declined ->
                    match declined.Data["meetups.denial_reason"], requestId with
                    | (:? string as denialReason), Some id ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error} {denial_reason} {request_id}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string declined.StatusCode,
                            declined.Status.Detail,
                            denialReason,
                            id
                        )
                    | (:? string as denialReason), None ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error} {denial_reason}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string declined.StatusCode,
                            declined.Status.Detail,
                            denialReason
                        )
                    | _, Some id ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error} {request_id}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string declined.StatusCode,
                            declined.Status.Detail,
                            id
                        )
                    | _, None ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string declined.StatusCode,
                            declined.Status.Detail
                        )

                    rethrow declined
                    return Unchecked.defaultof<'TResponse>
                // Отмена клиентом, истёкший deadline и остановка хоста. Клиент,
                // закрывший канал, не должен оставлять в журнале сервиса ошибку.
                | :? OperationCanceledException as cancelled ->
                    match requestId with
                    | Some id ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {request_id}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string StatusCode.Cancelled,
                            id
                        )
                    | None ->
                        logger.LogWarning(
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string StatusCode.Cancelled
                        )

                    rethrow cancelled
                    return Unchecked.defaultof<'TResponse>
                // Неожиданный отказ записывает та граница, на которой он стал
                // наблюдаемым. Исключение идёт отдельным аргументом ради
                // типизованной причины в OTLP, а error и stack — полями, потому
                // что каркас норматива запрашивается по именам полей.
                // error_category ждёт словаря из PER-66 и пока опущено.
                | unexpected ->
                    match requestId with
                    | Some id ->
                        logger.LogError(
                            unexpected,
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error} {stack} {request_id}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string StatusCode.Unknown,
                            unexpected.Message,
                            unexpected.StackTrace,
                            id
                        )
                    | None ->
                        logger.LogError(
                            unexpected,
                            "gRPC boundary {service} {operation} {result} {duration_us} {grpc_code} {error} {stack}",
                            service,
                            context.Method,
                            "error",
                            elapsedMicroseconds (),
                            string StatusCode.Unknown,
                            unexpected.Message,
                            unexpected.StackTrace
                        )

                    rethrow unexpected
                    return Unchecked.defaultof<'TResponse>
            }
