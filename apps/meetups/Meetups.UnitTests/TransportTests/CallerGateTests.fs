module Meetups.TransportTests.CallerGateTests

open System
open System.Collections.Concurrent
open System.Threading.Tasks
open Grpc.Core
open Meetups.Observability
open Meetups.TestKit
open Meetups.Transport
open Meetups.V1
open Microsoft.Extensions.Logging
open Swensen.Unquote
open Xunit

let private read name =
    match name with
    | "MEETUPS_CALLER_TOKEN_HUB_BOT" -> "bot-secret"
    | "MEETUPS_CALLER_TOKEN_NOTIFICATIONS" -> "notifications-secret"
    | "MEETUPS_SERVICE_TOKEN" -> "own-secret"
    | _ -> null

let private table = CallerTable.FromConfiguration(read, MethodAccess.declared)
let private path method = $"/{MeetupsService.Descriptor.FullName}/{method}"

let private refusal action =
    try
        action ()
        None
    with :? InvalidOperationException as ex ->
        Some ex.Message

let private headers (value: string) =
    let metadata = Metadata()

    if not (isNull value) then
        metadata.Add("authorization", value)

    metadata

let private interceptWithOutcome method authorization outcome =
    let context = FakeServerCallContext(path method, headers authorization)
    let sink = ConcurrentQueue<LogRecord>()

    use factory =
        LoggerFactory.Create(fun builder ->
            builder.AddProvider(new RecordingLoggerProvider(sink))
            |> ignore
        )

    let log = BoundaryLogInterceptor(factory.CreateLogger<BoundaryLogInterceptor>())
    let gate = CallerGateInterceptor table
    let mutable called = false

    let continuation =
        UnaryServerMethod<string, string>(fun _ _ ->
            called <- true

            if outcome = StatusCode.OK then
                Task.FromResult "answer"
            else
                Task.FromException<string>(RpcException(Status(outcome, "no right")))
        )

    let status =
        try
            log
                .UnaryServerHandler(
                    "request",
                    context,
                    UnaryServerMethod<string, string>(fun request context ->
                        gate.UnaryServerHandler(request, context, continuation)
                    )
                )
                .GetAwaiter()
                .GetResult()
            |> ignore

            StatusCode.OK
        with :? RpcException as ex ->
            ex.StatusCode

    status, called, List.ofSeq sink |> List.exactlyOne

let private intercept method authorization = interceptWithOutcome method authorization StatusCode.OK

[<Fact>]
let ``Method access should cover the contract and admit only its declared callers`` () =
    let contract =
        MeetupsService.Descriptor.Methods
        |> Seq.map _.Name
        |> Set.ofSeq

    let configured = MethodAccess.byMethod |> Map.keys |> Set.ofSeq

    test <@ contract = configured @>

    MethodAccess.byMethod
    |> Map.iter (fun method callers ->
        let expected =
            match method with
            | "ListMeetupStates" -> Set.empty
            | "CheckMeetupAuthority" -> Set.singleton Caller.Notifications
            | _ -> Set.singleton Caller.HubBot

        test <@ callers = expected @>
    )

[<Fact>]
let ``Caller gate should refuse absent empty and malformed bearer values`` () =
    let decisions =
        [
            null
            ""
            "Basic bot-secret"
            "Bearer "
            "Bearer    "
        ]
        |> List.map (CallerGate.decide table (path "CreateMeetupDraft"))

    test <@ decisions = List.replicate 5 GateDecision.MissingToken @>

[<Fact>]
let ``Caller gate should refuse unknown tokens regardless of length`` () =
    let decisions =
        [
            "x"
            "bot-secreu"
            String('x', 256)
            "own-secret"
        ]
        |> List.map (fun token -> CallerGate.decide table (path "CreateMeetupDraft") $"Bearer {token}")

    test <@ decisions = List.replicate 4 GateDecision.UnknownToken @>

[<Fact>]
let ``Caller gate should refuse known callers on methods that do not declare them`` () =
    test
        <@
            CallerGate.decide table (path "CreateMeetupDraft") "Bearer notifications-secret" = GateDecision.NotDeclared
                Caller.Notifications
            && CallerGate.decide table (path "CheckMeetupAuthority") "Bearer bot-secret" = GateDecision.NotDeclared
                Caller.HubBot
        @>

[<Fact>]
let ``Caller gate should close enumeration and future methods to every known caller`` () =
    for method in [ "ListMeetupStates"; "FutureMethod" ] do
        for caller in
            [
                Caller.HubBot
                Caller.Notifications
            ] do
            let decision =
                CallerGate.decide table (path method) $"Bearer {read caller.TokenVariable}"

            test <@ decision = GateDecision.NotDeclared caller @>

    test
        <@
            CallerGate.decide table "/other.v1.Service/CreateMeetupDraft" "Bearer bot-secret" = GateDecision.NotDeclared
                Caller.HubBot
        @>

[<Fact>]
let ``Caller table should reject every missing or blank declared token without disclosing values`` () =
    let errors =
        [
            Caller.HubBot
            Caller.Notifications
        ]
        |> List.collect (fun caller ->
            [ null; ""; "  " ]
            |> List.map (fun value ->
                let missing name = if name = caller.TokenVariable then value else read name

                refusal (fun () ->
                    CallerTable.FromConfiguration(missing, MethodAccess.declared)
                    |> ignore
                )
            )
        )

    test <@ errors |> List.forall Option.isSome @>

    test
        <@
            errors
            |> List.forall (fun error -> not (error.Value.Contains "secret"))
        @>

[<Fact>]
let ``Caller table should reject duplicate values after trimming without disclosing them`` () =
    let error =
        refusal (fun () ->
            CallerTable.FromConfiguration((fun _ -> " shared-secret "), MethodAccess.declared)
            |> ignore
        )

    test
        <@
            error.IsSome
            && not (error.Value.Contains "shared-secret")
        @>

[<Fact>]
let ``Caller table should identify normalized distinct tokens`` () =
    let padded name = $"  {read name}\n"
    let normalized = CallerTable.FromConfiguration(padded, MethodAccess.declared)

    test
        <@
            normalized.Identify "bot-secret" = Some Caller.HubBot
            && normalized.Identify "notifications-secret" = Some Caller.Notifications
        @>

    test
        <@
            CallerGate.decide normalized (path "CreateMeetupDraft") "bEaReR  bot-secret  " = GateDecision.Admitted
                Caller.HubBot
        @>

[<Fact>]
let ``Service token should reject missing blank and caller values without disclosing secrets`` () =
    let errors =
        [
            null
            ""
            " "
            "bot-secret"
            "notifications-secret"
        ]
        |> List.map (fun token ->
            refusal (fun () ->
                ServiceToken.fromConfiguration (fun _ -> token) table
                |> ignore
            )
        )

    test <@ errors |> List.forall Option.isSome @>

    test
        <@
            errors
            |> List.forall (fun error -> not (error.Value.Contains "secret"))
        @>

    test <@ ServiceToken.fromConfiguration read table = "own-secret" @>

[<Fact>]
let ``Boundary log should record the refusal and known caller without leaking authorization`` () =
    let cases =
        [
            null, "missing_token", None
            "Bearer stranger-secret", "unknown_token", None
            "Bearer notifications-secret", "not_declared", Some "notifications"
        ]

    for authorization, expectedReason, expectedCaller in cases do
        let status, called, entry = intercept "CreateMeetupDraft" authorization

        test
            <@
                status = StatusCode.Unauthenticated
                && not called
                && entry.Fields.TryFind "caller_refusal" = Some expectedReason
                && entry.Fields.TryFind "caller" = expectedCaller
                && entry.Fields.TryFind "error_category" = Some "authorization"
                && entry.Exception.IsNone
                && (entry.Fields
                    |> Map.forall (fun _ value -> not (value.Contains "secret")))
            @>

[<Fact>]
let ``Boundary log should name admitted callers even when a domain refusal follows`` () =
    let status, called, entry =
        intercept "CheckMeetupAuthority" "Bearer notifications-secret"

    test
        <@
            status = StatusCode.OK
            && called
            && entry.Fields.TryFind "caller" = Some "notifications"
            && not (entry.Fields.ContainsKey "caller_refusal")
        @>

    let denied, called, entry =
        interceptWithOutcome "CreateMeetupDraft" "Bearer bot-secret" StatusCode.PermissionDenied

    test
        <@
            denied = StatusCode.PermissionDenied
            && called
            && entry.Fields.TryFind "caller" = Some "hub-bot"
            && not (entry.Fields.ContainsKey "caller_refusal")
        @>

[<Fact>]
let ``Caller interceptor should refuse duplicate authorization before invoking the handler`` () =
    let metadata = headers "Bearer bot-secret"
    metadata.Add("authorization", "Bearer notifications-secret")
    let context = FakeServerCallContext(path "CreateMeetupDraft", metadata)
    let mutable called = false

    let denied =
        try
            (CallerGateInterceptor table)
                .UnaryServerHandler(
                    "request",
                    context,
                    UnaryServerMethod<string, string>(fun _ _ ->
                        called <- true
                        Task.FromResult "answer"
                    )
                )
            |> ignore

            None
        with :? RpcException as ex ->
            Some ex.StatusCode

    test
        <@
            denied = Some StatusCode.Unauthenticated
            && not called
        @>

[<Fact>]
let ``Method exemptions should include only health and reflection services`` () =
    let exempt =
        [
            "/grpc.health.v1.Health/Check"
            "/grpc.health.v1.Health/Watch"
            "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"
            "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo"
        ]

    test <@ exempt |> List.forall MethodAccess.isExempt @>

    test
        <@
            not (MethodAccess.isExempt (path "ListMeetupStates"))
            && not (MethodAccess.isExempt "/grpc.health.v1.HealthOther/Check")
        @>

[<Fact>]
let ``Caller interceptor should close every streaming handler before its continuation`` () =
    let gate = CallerGateInterceptor table
    let mutable called = false
    let request = Unchecked.defaultof<IAsyncStreamReader<string>>
    let response = Unchecked.defaultof<IServerStreamWriter<string>>
    let context () = FakeServerCallContext(path "FutureStream")

    let refused action =
        try
            action ()
            None
        with :? RpcException as ex ->
            Some ex.StatusCode

    let statuses =
        [
            refused (fun () ->
                gate.ClientStreamingServerHandler(
                    request,
                    context (),
                    ClientStreamingServerMethod<string, string>(fun _ _ ->
                        called <- true
                        Task.FromResult "answer"
                    )
                )
                |> ignore
            )
            refused (fun () ->
                gate.ServerStreamingServerHandler(
                    "request",
                    response,
                    context (),
                    ServerStreamingServerMethod<string, string>(fun _ _ _ ->
                        called <- true
                        Task.CompletedTask
                    )
                )
                |> ignore
            )
            refused (fun () ->
                gate.DuplexStreamingServerHandler(
                    request,
                    response,
                    context (),
                    DuplexStreamingServerMethod<string, string>(fun _ _ _ ->
                        called <- true
                        Task.CompletedTask
                    )
                )
                |> ignore
            )
        ]

    test
        <@
            statuses = List.replicate 3 (Some StatusCode.Unauthenticated)
            && not called
        @>
