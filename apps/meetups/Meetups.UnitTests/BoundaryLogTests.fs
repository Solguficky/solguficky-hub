module Meetups.BoundaryLogTests

open System
open System.Collections.Concurrent
open System.Threading
open System.Threading.Tasks
open Grpc.Core
open Meetups.Observability
open Meetups.TestKit
open Microsoft.Extensions.Logging
open Swensen.Unquote
open Xunit

/// Прогоняет один вызов через интерцептор и возвращает снятые записи вместе с
/// тем, что вылетело наружу: граница обязана и записать отказ, и пропустить его.
let private interceptWithContext (context: ServerCallContext) (continuation: unit -> Task<string>) =
    let records = ConcurrentQueue<LogRecord>()

    use factory =
        LoggerFactory.Create(fun builder ->
            builder.AddProvider(new RecordingLoggerProvider(records))
            |> ignore
        )

    let interceptor =
        BoundaryLogInterceptor(factory.CreateLogger<BoundaryLogInterceptor>())

    let thrown =
        try
            interceptor
                .UnaryServerHandler("request", context, UnaryServerMethod<string, string>(fun _ _ -> continuation ()))
                .GetAwaiter()
                .GetResult()
            |> ignore

            None
        with exn ->
            Some exn

    List.ofSeq records, thrown

let private intercept method continuation = interceptWithContext (FakeServerCallContext method) continuation

let private only records = List.exactlyOne records

let private product = "/meetups.v1.MeetupsService/GetMeetup"

[<Fact>]
let ``A successful call is recorded as ok with the transport code in its own field`` () =
    let records, thrown = intercept product (fun () -> Task.FromResult "answer")

    let record = only records

    test <@ thrown = None @>
    test <@ record.Level = LogLevel.Information @>
    test <@ record.Fields.TryFind "result" = Some "ok" @>
    test <@ record.Fields.TryFind "grpc_code" = Some "OK" @>
    test <@ record.Fields.TryFind "operation" = Some product @>

[<Fact>]
let ``A failure the service declared itself is a warning without a stack`` () =
    let declined = RpcException(Status(StatusCode.NotFound, "no such meetup"))

    let records, thrown =
        intercept product (fun () -> Task.FromException<string> declined)

    let record = only records

    // Отказ, объявленный контрактом, — не сбой сервиса: stack уровня Error
    // сделал бы каждый скрытый митап аварией в журнале.
    test <@ record.Level = LogLevel.Warning @>
    test <@ record.Fields.TryFind "grpc_code" = Some "NotFound" @>
    test <@ record.Fields.TryFind "error_category" = Some "invariant" @>
    test <@ record.Fields.ContainsKey "stack" = false @>
    test <@ thrown |> Option.map (fun exn -> exn.GetType()) = Some(typeof<RpcException>) @>

[<Fact>]
let ``A concealed meetup denial records its real reason only in the boundary log`` () =
    let declined = RpcException(Status(StatusCode.NotFound, "meetup not found"))
    declined.Data["meetups.denial_reason"] <- "not_visible"

    let records, thrown =
        intercept product (fun () -> Task.FromException<string> declined)

    let record = only records

    test <@ record.Fields.TryFind "denial_reason" = Some "not_visible" @>
    test <@ record.Fields.TryFind "error_category" = Some "visibility" @>
    test <@ declined.Status.Detail = "meetup not found" @>
    test <@ thrown = Some(declined :> exn) @>

[<Theory>]
[<InlineData(StatusCode.PermissionDenied, "authorization")>]
[<InlineData(StatusCode.FailedPrecondition, "invariant")>]
[<InlineData(StatusCode.Unavailable, "dependency_unavailable")>]
[<InlineData(StatusCode.DeadlineExceeded, "timeout")>]
let ``Declared failures use the shared category dictionary`` (code: StatusCode) expected =
    let declined = RpcException(Status(code, "declined"))
    let records, _ = intercept product (fun () -> Task.FromException<string> declined)

    test <@ (only records).Fields.TryFind "error_category" = Some expected @>

[<Fact>]
let ``Cancellation is a warning, not a service failure`` () =
    use cancelled = new CancellationTokenSource()
    cancelled.Cancel()

    let records, thrown =
        intercept product (fun () -> Task.FromCanceled<string> cancelled.Token)

    let record = only records

    test <@ record.Level = LogLevel.Warning @>
    test <@ record.Fields.TryFind "grpc_code" = Some "Cancelled" @>
    test <@ record.Fields.ContainsKey "error_category" = false @>
    test <@ record.Fields.ContainsKey "stack" = false @>
    test <@ thrown.IsSome @>

[<Fact>]
let ``An expired deadline is counted separately from client cancellation`` () =
    use cancelled = new CancellationTokenSource()
    cancelled.Cancel()

    let context =
        FakeServerCallContext(product, cancelled.Token, DateTime.UtcNow.AddSeconds -1.0)

    let records, _ =
        interceptWithContext context (fun () -> Task.FromCanceled<string> cancelled.Token)

    let record = only records

    test <@ record.Fields.TryFind "grpc_code" = Some "DeadlineExceeded" @>
    test <@ record.Fields.TryFind "error_category" = Some "timeout" @>

[<Fact>]
let ``An unexpected failure keeps its cause and is recorded once with a stack`` () =
    let broken = InvalidOperationException "storage is gone"

    let records, thrown =
        intercept product (fun () -> Task.FromException<string> broken)

    let record = only records

    test <@ record.Level = LogLevel.Error @>
    test <@ record.Fields.TryFind "result" = Some "error" @>
    test <@ record.Fields.TryFind "error" = Some "storage is gone" @>
    test <@ record.Fields.TryFind "error_category" = Some "unexpected" @>
    test <@ record.Exception = Some(broken :> exn) @>
    test <@ thrown = Some(broken :> exn) @>

[<Fact>]
let ``The readiness probe passes through without a record`` () =
    let records, thrown =
        intercept "/grpc.health.v1.Health/Check" (fun () -> Task.FromResult "serving")

    test <@ records = [] @>
    test <@ thrown = None @>
