/// Служебное перечисление текущего состояния без правил человеческой видимости.
module Meetups.Slices.ListMeetupStates

open System
open System.Text
open System.Threading.Tasks
open Dapper
open Grpc.Core
open Meetups.Infrastructure
open Microsoft.Extensions.DependencyInjection
open Npgsql

type Page = { Snapshots: Meetups.Domain.MeetupSnapshot list; Next: Guid option; ConsistentAt: DateTimeOffset }

let private decode token =
    if String.IsNullOrEmpty token then Ok None else
    try
        match Guid.TryParseExact(Encoding.UTF8.GetString(Convert.FromBase64String token), "D") with
        | true, id -> Ok(Some id)
        | _ -> Error()
    with :? FormatException -> Error()

let private encode (id: Guid) = id.ToString("D") |> Encoding.UTF8.GetBytes |> Convert.ToBase64String

let read (source: NpgsqlDataSource) after size : Task<Page> = task {
    use! connection = source.OpenConnectionAsync()
    use! transaction = connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead)
    let! at = connection.ExecuteScalarAsync<DateTimeOffset>("SELECT transaction_timestamp()", transaction = transaction)
    let! rows = connection.QueryAsync<MeetupRow.MeetupRow>(MeetupReading.selectAllSql + " WHERE (@after IS NULL OR id > @after) ORDER BY id LIMIT @limit", {| after = after |> Option.toNullable; limit = size + 1 |}, transaction)
    let values = rows |> Seq.toList
    do! transaction.CommitAsync()
    let selected = values |> List.truncate size
    return {
        Snapshots = selected |> List.map MeetupRow.toSnapshot
        Next = if values.Length > size then Some((selected |> List.last).Id) else None
        ConsistentAt = at
    }
}

module Api =
    let handle source (request: Meetups.V1.ListMeetupStatesRequest) = task {
        let size = if request.PageSize = 0 then 50 else request.PageSize
        if size < 1 || size > 100 then return raise (RpcException(Status(StatusCode.InvalidArgument, "page_size must be between 1 and 100")))
        match decode request.PageToken with
        | Error _ -> return raise (RpcException(Status(StatusCode.InvalidArgument, "page_token must be a token returned by the service")))
        | Ok after ->
            let! page = read source after size
            let response = Meetups.V1.ListMeetupStatesResponse(ConsistentAt = page.ConsistentAt.ToUniversalTime().UtcDateTime.ToString "o")
            response.Meetups.Add(page.Snapshots |> Seq.map Meetups.Slices.Contract.Outbound.snapshot)
            page.Next |> Option.iter (fun id -> response.NextPageToken <- encode id)
            return response
    }

module Composition =
    let source (services: IServiceProvider) = services.GetRequiredService<NpgsqlDataSource>()
