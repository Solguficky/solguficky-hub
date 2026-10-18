module Meetups.DbTests

open System
open System.Collections.Concurrent
open System.Diagnostics
open System.Net
open System.Net.Sockets
open Meetups.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

[<Theory>]
[<InlineData("57P01", true)>]
[<InlineData("57P02", true)>]
[<InlineData("57P03", true)>]
[<InlineData("08006", true)>]
[<InlineData("23505", false)>]
[<InlineData("42P01", false)>]
let ``A server refusal is unavailability only for connection states`` (sqlState: string) expected =
    let refused = PostgresException("refused", "FATAL", "FATAL", sqlState)

    test <@ Db.unavailable refused = expected @>

[<Fact>]
let ``A client-side Npgsql failure is unavailability`` () =
    test <@ Db.unavailable (NpgsqlException "Failed to connect") @>

[<Fact>]
let ``An unrelated failure is not unavailability`` () =
    test <@ not (Db.unavailable (InvalidOperationException "boom")) @>

[<Fact>]
let ``The pool gets a connect timeout below the client deadline when none is given`` () =
    let timeout =
        NpgsqlConnectionStringBuilder(Db.withConnectTimeout "Host=db;Database=meetups").Timeout

    test <@ timeout = Db.ConnectTimeoutSeconds @>

[<Fact>]
let ``An explicit connect timeout wins over the default`` () =
    let timeout =
        NpgsqlConnectionStringBuilder(Db.withConnectTimeout "Host=db;Database=meetups;Timeout=7").Timeout

    test <@ timeout = 7 @>

/// Слушатель принимает TCP и молчит: так выглядит база за прокси DCP, когда
/// контейнер PostgreSQL остановлен. Без предела подключения Npgsql ждал бы
/// 15 секунд, дольше трёх секунд дедлайна бота.
[<Fact>]
let ``A silent database is refused before the client deadline`` () =
    let listener = new TcpListener(IPAddress.Loopback, 0)
    listener.Start()
    let accepted = ConcurrentBag<Socket>()

    let rec accept () =
        listener.BeginAcceptSocket(
            (fun result ->
                try
                    accepted.Add(listener.EndAcceptSocket result)
                    accept ()
                with :? ObjectDisposedException ->
                    ()
            ),
            null
        )
        |> ignore

    accept ()

    try
        let port = (listener.LocalEndpoint :?> IPEndPoint).Port

        use source =
            Db.source $"postgres://meetups:none@127.0.0.1:{port}/meetups?sslmode=disable"

        let watch = Stopwatch.StartNew()

        let failure =
            try
                use _ = source.OpenConnection()
                None
            with error ->
                Some error

        watch.Stop()

        test <@ failure |> Option.exists Db.unavailable @>
        test <@ watch.Elapsed < TimeSpan.FromSeconds 2.5 @>
    finally
        listener.Stop()

        for socket in accepted do
            socket.Dispose()
