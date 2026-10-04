namespace Meetups.Transport

open System
open System.Threading.Tasks
open Grpc.Core
open Grpc.Core.Interceptors
open Meetups.V1

/// Колонка Caller integration.md. Новый метод без строки остаётся закрытым.
module MethodAccess =
    let private prefix = $"/{MeetupsService.Descriptor.FullName}/"
    let private bot = Set.singleton Caller.HubBot

    let byMethod =
        [
            "CreateMeetupDraft", bot
            "ChangeMeetupAttributes", bot
            "SetMeetupSchedule", bot
            "PublishMeetup", bot
            "ScheduleMeetupPublication", bot
            "CancelMeetupPublication", bot
            "UnpublishMeetup", bot
            "CancelMeetup", bot
            "AttachMaterial", bot
            "RemoveMaterial", bot
            "MarkMeetupHeld", bot
            "ListVisibleMeetups", bot
            "ListArchivedMeetups", bot
            "GetMeetup", bot
            "ListMeetupStates", Set.empty
            "CheckMeetupAuthority", set [ Caller.Notifications; Caller.Auction ]
        ]
        |> Map.ofList

    let declared = byMethod |> Map.values |> Set.unionMany

    let accepts (path: string) caller =
        path.StartsWith(prefix, StringComparison.Ordinal)
        && (byMethod.TryFind(path.Substring prefix.Length)
            |> Option.exists (Set.contains caller))

    /// Не «всё вне сервиса»: будущий сервис на этом хосте тоже закрыт по умолчанию.
    let isExempt (path: string) =
        [
            "/grpc.health.v1.Health/"
            "/grpc.reflection.v1.ServerReflection/"
            "/grpc.reflection.v1alpha.ServerReflection/"
        ]
        |> List.exists (fun prefix -> path.StartsWith(prefix, StringComparison.Ordinal))

[<RequireQualifiedAccess>]
type GateDecision =
    | Admitted of Caller
    | MissingToken
    | UnknownToken
    | NotDeclared of Caller

module CallerGate =
    let decisionKey = obj ()

    let decide (table: CallerTable) path (authorization: string) =
        if
            isNull authorization
            || not (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        then
            GateDecision.MissingToken
        else
            let token = authorization.Substring(7).Trim()

            if String.IsNullOrEmpty token then
                GateDecision.MissingToken
            else
                match table.Identify token with
                | None -> GateDecision.UnknownToken
                | Some caller when MethodAccess.accepts path caller -> GateDecision.Admitted caller
                | Some caller -> GateDecision.NotDeclared caller

    /// Только проверенное имя и фиксированная причина, ни одного значения заголовка.
    let fields (context: ServerCallContext) =
        match context.UserState.TryGetValue decisionKey with
        | true, (:? GateDecision as decision) ->
            match decision with
            | GateDecision.Admitted caller -> [ "caller", box caller.Node ]
            | GateDecision.NotDeclared caller ->
                [
                    "caller", box caller.Node
                    "caller_refusal", box "not_declared"
                ]
            | GateDecision.MissingToken ->
                [
                    "caller_refusal", box "missing_token"
                ]
            | GateDecision.UnknownToken ->
                [
                    "caller_refusal", box "unknown_token"
                ]
        | _ -> []

/// Внутри интерцептора лога: его запись охватывает и отказ вызывающему.
type CallerGateInterceptor(table: CallerTable) =
    inherit Interceptor()

    let admit (context: ServerCallContext) =
        if not (MethodAccess.isExempt context.Method) then
            // Несколько authorization неоднозначны: не выбирать один молча.
            let authorization =
                context.RequestHeaders
                |> Seq.filter (fun entry -> entry.Key = "authorization")
                |> Seq.toList
                |> function
                    | [ entry ] when not entry.IsBinary -> entry.Value
                    | _ -> null

            let decision = CallerGate.decide table context.Method authorization
            context.UserState[CallerGate.decisionKey] <- decision

            match decision with
            | GateDecision.Admitted _ -> ()
            | GateDecision.MissingToken
            | GateDecision.UnknownToken
            | GateDecision.NotDeclared _ -> raise (RpcException(Status(StatusCode.Unauthenticated, "unauthenticated")))

    override _.UnaryServerHandler<'Request, 'Response when 'Request: not struct and 'Response: not struct>
        (request: 'Request, context: ServerCallContext, continuation: UnaryServerMethod<'Request, 'Response>)
        =
        admit context
        continuation.Invoke(request, context)

    override _.ClientStreamingServerHandler<'Request, 'Response when 'Request: not struct and 'Response: not struct>
        (
            stream: IAsyncStreamReader<'Request>,
            context: ServerCallContext,
            continuation: ClientStreamingServerMethod<'Request, 'Response>
        ) =
        admit context
        continuation.Invoke(stream, context)

    override _.ServerStreamingServerHandler<'Request, 'Response when 'Request: not struct and 'Response: not struct>
        (
            request: 'Request,
            stream: IServerStreamWriter<'Response>,
            context: ServerCallContext,
            continuation: ServerStreamingServerMethod<'Request, 'Response>
        ) : Task =
        admit context
        continuation.Invoke(request, stream, context)

    override _.DuplexStreamingServerHandler<'Request, 'Response when 'Request: not struct and 'Response: not struct>
        (
            request: IAsyncStreamReader<'Request>,
            response: IServerStreamWriter<'Response>,
            context: ServerCallContext,
            continuation: DuplexStreamingServerMethod<'Request, 'Response>
        ) : Task =
        admit context
        continuation.Invoke(request, response, context)
