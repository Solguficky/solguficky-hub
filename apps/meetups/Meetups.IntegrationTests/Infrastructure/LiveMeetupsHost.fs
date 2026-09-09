namespace Meetups.IntegrationTests.Infrastructure

open System
open System.Collections.Concurrent
open Grpc.Net.Client
open Meetups.TestKit
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting.Server
open Microsoft.AspNetCore.Hosting.Server.Features
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Logging

/// Тот же composition root, что и запуск, но с настоящей изолированной базой.
/// Этим проверяется сквозной путь «запрос — срез — PostgreSQL — снимок в ответе»:
/// без него критерий «команды отвечают через grpcurl без Telegram» подтверждался бы
/// только руками.
///
/// Не IClassFixture, и это не вкус: IsolatedDatabase зовёт Assert.Skip, а skip из
/// конструктора class fixture xUnit показывает падением класса, и прогон на машине
/// без Docker покраснел бы. Поэтому хост создаётся в теле теста через use — тем же
/// приёмом, что и в тестах схемы.
type LiveMeetupsHost() =
    let db = new IsolatedDatabase()
    let records = ConcurrentQueue<LogRecord>()

    let app =
        try
            Meetups.Migrations.apply db.ConnectionString

            // Порт 0: адрес назначает система, параллельные прогоны не конфликтуют.
            Meetups.Host.build
                [|
                    "--urls=http://127.0.0.1:0"
                    $"--{Meetups.Migrations.DatabaseUrlVariable}={db.ConnectionString}"
                |]
        with _ ->
            (db :> IDisposable).Dispose()
            reraise ()

    // Kestrel слушает уже после StartAsync, поэтому всё, что может бросить после
    // него, обёрнуто: исключение в конструкторе не даёт xUnit позвать Dispose, и без
    // этого слушающий хост и созданная база остались бы жить до конца прогона.
    let channel =
        try
            app.Services.GetRequiredService<ILoggerFactory>().AddProvider(new RecordingLoggerProvider(records))
            app.StartAsync().GetAwaiter().GetResult()

            app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>().Addresses
            |> Seq.head
            |> GrpcChannel.ForAddress
        with _ ->
            app.StopAsync().GetAwaiter().GetResult()
            // DisposeAsync, а не только StopAsync: остановка хоста не разбирает
            // контейнер, и NpgsqlDataSource с его пулом пережил бы исключение,
            // удерживая соединения к базе, которую следующей строкой дропает Dispose.
            (app :> IAsyncDisposable).DisposeAsync().AsTask().GetAwaiter().GetResult()
            (db :> IDisposable).Dispose()
            reraise ()

    member _.Channel = channel

    /// Нужен утверждениям про строки: отказ по праву обязан не только вернуть код,
    /// но и ничего не записать.
    member _.ConnectionString = db.ConnectionString

    member _.Records = List.ofSeq records

    interface IDisposable with
        member _.Dispose() =
            channel.Dispose()
            app.StopAsync().GetAwaiter().GetResult()
            (app :> IAsyncDisposable).DisposeAsync().AsTask().GetAwaiter().GetResult()
            (db :> IDisposable).Dispose()
