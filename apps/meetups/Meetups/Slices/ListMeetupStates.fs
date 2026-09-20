/// Срез «перечислить текущее состояние». Служебный: страницу читает реплика, а не
/// человек, поэтому смотрящего он не принимает и правил человеческой видимости не
/// применяет. Скрытая сходка в ответе — не утечка, а условие задачи.
module Meetups.Slices.ListMeetupStates

open System
open System.Text
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

/// Размер страницы по умолчанию и её потолок названы контрактом, поэтому стоят
/// рядом с проверкой, а не в конфигурации: потребителю обещана именно эта граница.
let defaultPageSize = 50

let maxPageSize = 100

type Query =
    {
        After: MeetupId option
        Size: int
    }

/// Страница наружу: снимки, ключ продолжения и момент, на который она согласована.
type Page =
    {
        Snapshots: MeetupSnapshot list
        Next: MeetupId option
        ConsistentAt: DateTimeOffset
    }

[<RequireQualifiedAccess; NoComparison>]
type ListMeetupStatesError =
    | MalformedPageToken
    | PageSizeOutOfRange of requested: int

/// Курсор непрозрачен по контракту, поэтому его форма — деталь этого среза и
/// меняется без версии сообщения. base64 от канонической строки идентификатора:
/// сервис не держит на своей стороне состояния обхода, а потребитель не может
/// собрать курсор сам и начать обход с середины выдуманного ключа.
module Cursor =

    let encode (MeetupId id) : string =
        id.ToString "D"
        |> Encoding.UTF8.GetBytes
        |> Convert.ToBase64String

    let decode (token: string) : Result<MeetupId option, unit> =
        if String.IsNullOrEmpty token then
            Ok None
        else
            try
                let bytes = Convert.FromBase64String token
                let text = Encoding.UTF8.GetString bytes

                match Guid.TryParseExact(text, "D") with
                | true, id -> Ok(Some(MeetupId id))
                | false, _ -> Error()
            with :? FormatException ->
                Error()

/// Читается на строку больше запрошенного: лишняя строка — единственный признак
/// того, что обход не закончен. Отдельный COUNT прошёл бы всю таблицу и всё равно
/// ответил бы про другой момент, а пустая последняя страница заставила бы
/// потребителя сделать лишний вызов, чтобы узнать, что он уже всё прочитал.
let execute (read: MeetupId option -> int -> Task<MeetupReading.StatesPage>) (query: Query) : Task<Page> =
    task {
        let! page = read query.After (query.Size + 1)
        let selected = page.Snapshots |> List.truncate query.Size
        let hasMore = page.Snapshots.Length > query.Size
        let last = selected |> List.tryLast |> Option.map _.Id
        let next = if hasMore then last else None

        return
            {
                Snapshots = selected
                Next = next
                ConsistentAt = page.ConsistentAt
            }
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildRead (services: IServiceProvider) =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        MeetupReading.readStates source

module Api =

    open Grpc.Core

    let private toStatus (error: ListMeetupStatesError) : Status =
        match error with
        | ListMeetupStatesError.MalformedPageToken ->
            Status(StatusCode.InvalidArgument, "page_token must be a token returned by this service")
        | ListMeetupStatesError.PageSizeOutOfRange requested ->
            Status(StatusCode.InvalidArgument, $"page_size {requested} is outside 1..{maxPageSize}")

    /// Контракт требует RFC 3339 UTC с Z, а формат "o" у DateTimeOffset печатает
    /// смещение +00:00, поэтому момент идёт через UtcDateTime — как и в Contract.
    let private moment (at: DateTimeOffset) : string = at.ToUniversalTime().UtcDateTime.ToString "o"

    let private toQuery (request: Meetups.V1.ListMeetupStatesRequest) : Result<Query, ListMeetupStatesError> =
        let requested = request.PageSize
        let size = if requested = 0 then defaultPageSize else requested

        if size < 1 || size > maxPageSize then
            Error(ListMeetupStatesError.PageSizeOutOfRange requested)
        else
            match Cursor.decode request.PageToken with
            | Error _ -> Error ListMeetupStatesError.MalformedPageToken
            | Ok after ->
                Ok
                    {
                        After = after
                        Size = size
                    }

    let handle
        (read: MeetupId option -> int -> Task<MeetupReading.StatesPage>)
        (request: Meetups.V1.ListMeetupStatesRequest)
        : Task<Meetups.V1.ListMeetupStatesResponse> =
        task {
            match toQuery request with
            | Error error -> return raise (RpcException(toStatus error))
            | Ok query ->
                let! page = execute read query

                let contracts =
                    page.Snapshots
                    |> List.map Contract.Outbound.snapshot

                let response = Meetups.V1.ListMeetupStatesResponse()
                response.ConsistentAt <- moment page.ConsistentAt
                response.Meetups.Add(contracts)

                match page.Next with
                | Some id -> response.NextPageToken <- Cursor.encode id
                | None -> ()

                return response
        }
