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

/// Поднимает настоящий Kestrel на свободном порту и держит канал к нему.
///
/// Хост собирает Meetups.Host.build — тот же composition root, что и запуск,
/// поэтому тест проверяет регистрацию DI, маршрутизацию gRPC, h2c и
/// сериализацию Protobuf целиком, а не их пересборку внутри теста.
///
/// База этому классу не нужна и не должна быть нужна: сюда попадают проверки
/// каркаса и те отказы границы, которые принимаются до обращения к хранилищу.
/// Docker для них не требуется, и прогон остаётся зелёным на пустой машине.
type MeetupsHostFixture() =
    let records = ConcurrentQueue<LogRecord>()

    // Адрес синтаксически валиден и заведомо недостижим. NpgsqlDataSource.Create
    // соединение не открывает, поэтому singleton резолвится и хост поднимается;
    // упадёт только вызов, который действительно пойдёт в базу. Пустая переменная
    // не годится: Host.build на ней делает failwith уже при разрешении.
    // Порт 0 в --urls: адрес назначает система, параллельные прогоны не конфликтуют.
    let app =
        Meetups.Host.build
            [|
                "--urls=http://127.0.0.1:0"
                "--MEETUPS_DATABASE_URL=postgres://meetups:none@127.0.0.1:1/meetups?sslmode=disable"
            |]

    // Kestrel слушает уже после StartAsync, поэтому всё, что может бросить после
    // него, обёрнуто: исключение в конструкторе не даёт xUnit позвать Dispose, и
    // без этого слушающий хост остался бы жить до конца прогона.
    let channel =
        try
            app.Services.GetRequiredService<ILoggerFactory>().AddProvider(new RecordingLoggerProvider(records))
            app.StartAsync().GetAwaiter().GetResult()

            app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>().Addresses
            |> Seq.head
            |> GrpcChannel.ForAddress
        with _ ->
            app.StopAsync().GetAwaiter().GetResult()
            reraise ()

    member _.Channel = channel

    /// Записи каркаса границы, снятые с работающего хоста. Очередь общая на класс
    /// тестов, поэтому утверждение фильтрует её по своей операции, а не берёт
    /// первую попавшуюся запись.
    member _.Records = List.ofSeq records

    interface IDisposable with
        member _.Dispose() =
            channel.Dispose()
            app.StopAsync().GetAwaiter().GetResult()
            (app :> IAsyncDisposable).DisposeAsync().AsTask().GetAwaiter().GetResult()
