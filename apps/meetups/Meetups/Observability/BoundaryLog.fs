namespace Meetups.Observability

open System
open System.Diagnostics
open System.Runtime.ExceptionServices
open System.Threading.Tasks
open Grpc.Core
open Grpc.Core.Interceptors
open Microsoft.Extensions.Logging
open Npgsql
open Meetups

/// Транспортная граница сервиса: заполняет каркас записи об операции из
/// docs/standards/observability/logging.md. Каркас заполняет граница, а не
/// вызываемый код, поэтому запись рождается здесь и больше нигде.
type BoundaryLogInterceptor(logger: ILogger<BoundaryLogInterceptor>) =
    inherit Interceptor()

    /// Имя сервиса — константа его сборки, а не метка сборщика логов:
    /// значение внутри записи переживает смену транспорта доставки.
    static let service = Failures.Service

    // Счётчик отказов общий с фоновой границей: у него два потребителя, и живёт он
    // в Observability/Failures.fs.
    static let countFailure (category: string) = Failures.count category

    static let declaredCategory (declined: RpcException) =
        match declined.Data["meetups.denial_reason"] with
        | :? string as reason when reason = "not_visible" -> "visibility"
        | _ ->
            match declined.StatusCode with
            | StatusCode.PermissionDenied
            | StatusCode.Unauthenticated -> "authorization"
            | StatusCode.InvalidArgument
            | StatusCode.FailedPrecondition
            | StatusCode.Aborted
            | StatusCode.AlreadyExists
            | StatusCode.NotFound
            | StatusCode.OutOfRange -> "invariant"
            | StatusCode.DeadlineExceeded -> "timeout"
            | StatusCode.Unavailable -> "dependency_unavailable"
            | _ -> "unexpected"

    /// Проба готовности не начата человеком и сценария не имеет. Она идёт
    /// каждые несколько секунд, поэтому её запись была бы шумом, а не журналом.
    static let isProbe (method: string) = method.StartsWith "/grpc.health.v1.Health/"

    static let requestId context =
        IncomingMetadata.requestId context
        |> Option.map RequestId.value

    static let useCase context = IncomingMetadata.useCase context

    static let optional name value extras =
        match value with
        | Some v -> extras @ [ name, box v ]
        | None -> extras

    static let frame (context: ServerCallContext) result duration grpcCode extras =
        [
            "service", box service
            "operation", box context.Method
            "result", box result
            "duration_us", box duration
            "grpc_code", box grpcCode
        ]
        |> optional "request_id" (requestId context)
        |> optional "use_case" (useCase context)
        |> fun fields -> fields @ extras

    /// reraise() внутри task недоступен: он разрешён только прямо в with-блоке.
    /// Capture().Throw() сохраняет исходный stack.
    static let rethrow (exn: exn) = ExceptionDispatchInfo.Capture(exn).Throw()

    let write (level: LogLevel) (error: exn option) (fields: (string * obj) list) =
        let template =
            "gRPC boundary "
            + String.concat
                " "
                (fields
                 |> List.map (fun (name, _) -> "{" + name + "}"))

        let values = fields |> List.map snd |> List.toArray

        match error with
        | Some exn -> logger.Log(level, exn, template, values)
        | None -> logger.Log(level, template, values)

    override _.UnaryServerHandler<'TRequest, 'TResponse when 'TRequest: not struct and 'TResponse: not struct>
        (request: 'TRequest, context: ServerCallContext, continuation: UnaryServerMethod<'TRequest, 'TResponse>)
        : Task<'TResponse> =
        if isProbe context.Method then
            continuation.Invoke(request, context)
        else
            task {
                let started = Stopwatch.GetTimestamp()
                let elapsedMicroseconds () = int64 (Stopwatch.GetElapsedTime started).TotalMicroseconds

                try
                    let! response = continuation.Invoke(request, context)

                    write
                        LogLevel.Information
                        None
                        (frame context "ok" (elapsedMicroseconds ()) (string StatusCode.OK) [])

                    return response
                with
                // Отказ, который сервис объявил сам, — часть контракта, а не сбой
                // сервиса. Уровень Warning и никакого stack: норматив держит stack
                // для неожиданного отказа.
                | :? RpcException as declined ->
                    let category = declaredCategory declined
                    countFailure category

                    let extras =
                        [
                            "error_category", box category
                            "error", box declined.Status.Detail
                        ]
                        |> fun fields ->
                            match declined.Data["meetups.denial_reason"] with
                            | :? string as denialReason -> fields @ [ "denial_reason", box denialReason ]
                            | _ -> fields

                    write
                        LogLevel.Warning
                        None
                        (frame context "error" (elapsedMicroseconds ()) (string declined.StatusCode) extras)

                    rethrow declined
                    return Unchecked.defaultof<'TResponse>
                // Отмена клиентом, истёкший deadline и остановка хоста. Клиент,
                // закрывший канал, не должен оставлять в журнале сервиса ошибку.
                | :? OperationCanceledException as cancelled ->
                    if context.Deadline <= DateTime.UtcNow then
                        countFailure "timeout"

                        write
                            LogLevel.Warning
                            None
                            (frame
                                context
                                "error"
                                (elapsedMicroseconds ())
                                (string StatusCode.DeadlineExceeded)
                                [ "error_category", box "timeout" ])
                    else
                        write
                            LogLevel.Warning
                            None
                            (frame context "error" (elapsedMicroseconds ()) (string StatusCode.Cancelled) [])

                    rethrow cancelled
                    return Unchecked.defaultof<'TResponse>
                // Неожиданный отказ записывает та граница, на которой он стал
                // наблюдаемым. Исключение идёт отдельным аргументом ради
                // типизованной причины в OTLP, а error и stack — полями, потому
                // что каркас норматива запрашивается по именам полей.
                | unexpected ->
                    let category =
                        match unexpected with
                        | :? TimeoutException -> "timeout"
                        | :? NpgsqlException -> "dependency_unavailable"
                        | _ -> "unexpected"

                    countFailure category

                    write
                        LogLevel.Error
                        (Some unexpected)
                        (frame
                            context
                            "error"
                            (elapsedMicroseconds ())
                            (string StatusCode.Unknown)
                            [
                                "error_category", box category
                                "error", box unexpected.Message
                                "stack", box unexpected.StackTrace
                            ])

                    rethrow unexpected
                    return Unchecked.defaultof<'TResponse>
            }
