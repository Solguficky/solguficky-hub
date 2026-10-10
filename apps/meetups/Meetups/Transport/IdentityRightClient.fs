/// Адаптер порта Identity для `CheckMeetupAuthority` (ADR-051): один вызов
/// `CheckAccessRight` и сведение его ответа к словарю среза. Решения о допуске он не
/// принимает — какое право спрашивать и что делать с ответом, решает срез.
module Meetups.Transport.IdentityRightClient

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
        -> Identity.V1.CheckAccessRightRequest
        -> Task<Identity.V1.CheckAccessRightResponse>

let private right (value: AccessRight) : Identity.V1.AccessRight =
    match value with
    | AccessHub -> Identity.V1.AccessRight.AccessHub
    | PlaceBids -> Identity.V1.AccessRight.PlaceBids
    | ManageMembers -> Identity.V1.AccessRight.ManageMembers
    | AdmitBidders -> Identity.V1.AccessRight.AdmitBidders
    | ManageMeetups -> Identity.V1.AccessRight.ManageMeetups
    | GrantAdmins -> Identity.V1.AccessRight.GrantAdmins

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
let metadata (serviceToken: string) (forwarded: Forwarded) : Metadata =
    let headers = Metadata()
    headers.Add("authorization", $"Bearer {serviceToken}")

    forwarded.RequestId
    |> Option.iter (fun id -> headers.Add("x-request-id", RequestId.value id))

    forwarded.UseCase
    |> Option.iter (fun useCase -> headers.Add("x-use-case", useCase))

    headers

let ask (send: Send) (serviceToken: string) (deadline: TimeSpan) (forwarded: Forwarded) : AskRight =
    fun (PersonId person) required ->
        task {
            let request =
                Identity.V1.CheckAccessRightRequest(IdentityId = person.ToString "D", Right = right required)

            try
                let due = min (DateTime.UtcNow + deadline) forwarded.Deadline

                let! response = send (metadata serviceToken forwarded) due forwarded.Cancellation request
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
        client.CheckAccessRightAsync(request, headers, Nullable deadline, cancellation).ResponseAsync
