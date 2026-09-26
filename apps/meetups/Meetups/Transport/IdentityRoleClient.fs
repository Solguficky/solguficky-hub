/// Адаптер порта Identity для `CheckMeetupAuthority` (ADR-051): один вызов
/// `CheckGlobalRole` и сведение его ответа к словарю среза. Решения о праве он не
/// принимает — какие роли спрашивать и что делать с ответом, решает срез.
module Meetups.Transport.IdentityRoleClient

open System
open System.Threading.Tasks
open Grpc.Core
open Grpc.Net.Client
open Meetups
open Meetups.Domain
open Meetups.Slices.CheckMeetupAuthority

/// Адрес Identity. Префикс сервиса, как у `MEETUPS_NATS_URL`: переменную читает
/// Meetups, и имя говорит, кто её потребитель.
[<Literal>]
let UrlVariable = "MEETUPS_IDENTITY_GRPC_URL"

/// Верхняя граница одного вызова. Повторов нет, потому что ответ ждёт вызывающий
/// сервис на своей команде, а вторая попытка за него — его выбор. Срок короче у
/// вызывающего — действует его срок. Истёкший срок — «право не подтверждено», а не
/// отказ (ADR-051, п. 6).
let defaultDeadline = TimeSpan.FromSeconds 2.0

/// Отправка одного запроса. Функция, а не сгенерированный клиент, чтобы сведение
/// статусов и состав запроса проверялись unit-тестом без сервера — тем же приёмом,
/// что `Send` у адаптера публикации.
type Send =
    Metadata
        -> DateTime
        -> Threading.CancellationToken
        -> Identity.V1.CheckGlobalRoleRequest
        -> Task<Identity.V1.CheckGlobalRoleResponse>

let private role (value: GlobalRole) : Identity.V1.GlobalRole =
    match value with
    | Maintainer -> Identity.V1.GlobalRole.Maintainer
    | Administrator -> Identity.V1.GlobalRole.Admin
    | Member -> Identity.V1.GlobalRole.Member
    | Public -> Identity.V1.GlobalRole.Public

/// Сведение отказа Identity (ADR-051, п. 6). NOT_FOUND — неизвестный Identity
/// человек — становится тем же «нет», что и `granted = false`: иначе посторонний
/// отличил бы несуществующий идентификатор от существующего. Недоступность и истёкший
/// срок — «право не подтверждено». Всё остальное, включая INVALID_ARGUMENT, —
/// дефект одной из сторон: разбор уже отверг бы то, что Identity сочтёт неверным.
let classify (status: Status) : Result<bool, IdentityFailure> =
    match status.StatusCode with
    | StatusCode.NotFound -> Ok false
    | StatusCode.Unavailable
    | StatusCode.DeadlineExceeded -> Error(IdentityFailure.Unavailable $"identity {status.StatusCode}")
    | code -> Error(IdentityFailure.Failed $"identity {code}")

/// Заголовки цепочки: пустые не отправляются, как и не записываются в лог.
let metadata (forwarded: Forwarded) : Metadata =
    let headers = Metadata()

    forwarded.RequestId
    |> Option.iter (fun id -> headers.Add("x-request-id", RequestId.value id))

    forwarded.UseCase
    |> Option.iter (fun useCase -> headers.Add("x-use-case", useCase))

    headers

let ask (send: Send) (deadline: TimeSpan) (forwarded: Forwarded) : AskRoles =
    fun (PersonId person) roles ->
        task {
            let request = Identity.V1.CheckGlobalRoleRequest(IdentityId = person.ToString "D")

            request.AcceptedRoles.AddRange(roles |> Seq.map role)

            try
                let due = min (DateTime.UtcNow + deadline) forwarded.Deadline

                let! response = send (metadata forwarded) due forwarded.Cancellation request
                return Ok response.Granted
            with :? RpcException as declined ->
                return classify declined.Status
        }

/// Канал собран сразу, но соединение не открывается до первого вызова: хост
/// поднимается при недоступном Identity, а отказ приходит ответом на запрос.
///
/// Канал свой, а не `AddGrpcClient`: фабрика клиентов наследует от ServiceDefaults
/// стандартный обработчик устойчивости с повторами и своим сроком в десятки секунд,
/// и срок вызова перестал бы быть единственным. Схема `http://` — h2c, как у
/// остальных сервисов в локальном графе.
let connect (url: string) : Send =
    let channel = GrpcChannel.ForAddress url
    let client = Identity.V1.IdentityService.IdentityServiceClient channel

    fun headers deadline cancellation request ->
        client.CheckGlobalRoleAsync(request, headers, Nullable deadline, cancellation).ResponseAsync
