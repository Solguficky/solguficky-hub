module Meetups.IdentityRoleClientTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups
open Meetups.Domain
open Meetups.Slices.CheckMeetupAuthority
open Meetups.TestData
open Meetups.Transport
open Swensen.Unquote
open Xunit

let private forwarded: Forwarded =
    {
        RequestId = RequestId.create "req-1"
        UseCase = Some "manual_broadcast"
        Deadline = DateTime.MaxValue
        Cancellation = Threading.CancellationToken.None
    }

/// Отправка, которая записывает запрос, заголовки, срок и отмену и отвечает заданным.
type private Recorder(respond: unit -> Task<Identity.V1.CheckGlobalRoleResponse>) =
    let sent =
        ResizeArray<Metadata * DateTime * Threading.CancellationToken * Identity.V1.CheckGlobalRoleRequest>()

    member _.Sent = List.ofSeq sent

    member _.Send: IdentityRoleClient.Send =
        fun headers deadline cancellation request ->
            sent.Add(headers, deadline, cancellation, request)
            respond ()

let private runWith (incoming: Forwarded) (send: IdentityRoleClient.Send) =
    IdentityRoleClient.ask send (TimeSpan.FromSeconds 2.0) incoming Sample.authorId (Set.singleton Administrator)
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private run (send: IdentityRoleClient.Send) = runWith forwarded send

let private granting () = Task.FromResult(Identity.V1.CheckGlobalRoleResponse(Granted = true))

let private declining (code: StatusCode) () : Task<Identity.V1.CheckGlobalRoleResponse> =
    Task.FromException<Identity.V1.CheckGlobalRoleResponse>(RpcException(Status(code, "declined")))

[<Fact>]
let ``The adapter asks Identity about the person with the roles it was given`` () =
    let recorder =
        Recorder(fun () -> Task.FromResult(Identity.V1.CheckGlobalRoleResponse(Granted = true)))

    let before = DateTime.UtcNow
    let result = run recorder.Send
    let headers, deadline, _, request = recorder.Sent |> List.exactlyOne
    let (PersonId person) = Sample.authorId
    // Строка снаружи цитаты: вызов метода у Guid берёт адрес локальной структуры.
    let expectedId = person.ToString "D"

    test
        <@
            result = Ok true
            && request.IdentityId = expectedId
            && List.ofSeq request.AcceptedRoles = [ Identity.V1.GlobalRole.Admin ]
            && deadline > before
            && deadline
               <= DateTime.UtcNow + TimeSpan.FromSeconds 2.0
            && headers.GetValue "x-request-id" = "req-1"
            && headers.GetValue "x-use-case" = "manual_broadcast"
        @>

[<Fact>]
let ``A refusal by Identity is a refusal of the right`` () =
    let result =
        run (Recorder(fun () -> Task.FromResult(Identity.V1.CheckGlobalRoleResponse(Granted = false)))).Send

    test <@ result = Ok false @>

/// Заголовок, которого граница не получила, дальше не уходит пустым.
[<Fact>]
let ``Absent chain values are not forwarded`` () =
    let headers =
        IdentityRoleClient.metadata
            { forwarded with
                RequestId = None
                UseCase = None
            }

    test <@ headers.Count = 0 @>

/// Вызывающий, который ждёт меньше двух секунд, ограничивает и вызов Identity, а его
/// отмена отменяет и этот вызов: иначе Meetups отвечал бы в закрытый поток.
[<Fact>]
let ``The caller's shorter deadline and its cancellation bound the Identity call`` () =
    use cancellation = new Threading.CancellationTokenSource()
    let callerDeadline = DateTime.UtcNow + TimeSpan.FromMilliseconds 300.0
    let recorder = Recorder granting

    runWith
        { forwarded with
            Deadline = callerDeadline
            Cancellation = cancellation.Token
        }
        recorder.Send
    |> ignore

    let _, deadline, token, _ = recorder.Sent |> List.exactlyOne
    let expectedToken = cancellation.Token

    test <@ deadline = callerDeadline && token = expectedToken @>

/// Сведение проверяется на всём словаре кодов: ни один отказ Identity не становится
/// правом, неизвестный человек неотличим от человека без роли, а «не подтверждено»
/// отделено от дефекта (ADR-051, п. 6).
[<Fact>]
let ``Every Identity status reduces to a refusal, an unconfirmed right or a failure`` () =
    let reduced =
        Enum.GetValues<StatusCode>()
        |> Array.filter (fun code -> code <> StatusCode.OK)
        |> Array.map (fun code -> code, run (Recorder(declining code)).Send)
        |> List.ofArray

    let expected (code: StatusCode) =
        match code with
        | StatusCode.NotFound -> Ok false
        | StatusCode.Unavailable
        | StatusCode.DeadlineExceeded -> Error(IdentityFailure.Unavailable $"identity {code}")
        | _ -> Error(IdentityFailure.Failed $"identity {code}")

    test
        <@
            reduced
            |> List.forall (fun (code, result) -> result = expected code)
        @>

    test
        <@
            reduced
            |> List.forall (fun (_, result) -> result <> Ok true)
        @>
