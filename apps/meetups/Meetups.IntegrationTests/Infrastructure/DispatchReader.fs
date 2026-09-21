/// Прогон продуктового тика публикации против настоящей базы.
///
/// Зависимости собираются тем же `Composition.buildDeps`, что и в хосте, а не
/// повторяются здесь руками: иначе сценарий проверял бы сборку, написанную ради
/// теста, и разошёлся бы с продуктом молча — вместе с SQL, отображением строки и
/// размером пачки.
module Meetups.IntegrationTests.Infrastructure.DispatchReader

open System
open System.Threading
open System.Threading.Tasks
open Meetups.Slices.DispatchMeetupEvents
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Npgsql

/// Порт, который записывает отданное ему и отвечает заранее выбранным исходом.
/// Рукописный fake, а не библиотека моков: у порта одна функция, и записать вызовы
/// дешевле, чем объяснять это фреймворку.
type RecordingPort(answer: PendingEvent -> PublishOutcome) =
    let published = ResizeArray<PendingEvent>()

    member _.Published = List.ofSeq published

    member _.PublishedIds = published |> Seq.map _.EventId |> List.ofSeq

    member _.Publish: CancellationToken -> PendingEvent -> Task<PublishOutcome> =
        fun _ event ->
            published.Add event
            Task.FromResult(answer event)

let confirming () = RecordingPort(fun _ -> PublishOutcome.Confirmed)

let declining (reason: string) = RecordingPort(fun _ -> PublishOutcome.Declined reason)

/// Соперник, который держит ход своей сессией.
///
/// Пассивный намеренно: им управляет сам тест, второго потока в сценарии нет вовсе,
/// и порядок задан последовательностью строк. `pg_try_advisory_lock` отвечает
/// синхронно, ждать нечего — поэтому проверка изоляции не может замигать.
///
/// Соединение своё, а не из пула продукта: захват реентерабелен внутри одной сессии,
/// и проверка «занято ли» из той же сессии всегда отвечала бы «свободно».
type RivalTurn(dsn: string) =
    let connection = new NpgsqlConnection(dsn)

    do connection.Open()

    let held =
        use command =
            new NpgsqlCommand(
                $"SELECT pg_try_advisory_lock({Meetups.Infrastructure.DispatchStore.TurnKey})",
                connection
            )

        command.ExecuteScalar() :?> bool

    member _.Held = held

    interface IDisposable with
        member _.Dispose() = connection.Dispose()

let private provider (source: NpgsqlDataSource) (batchSize: int) =
    let configuration =
        ConfigurationBuilder()
            .AddInMemoryCollection(
                dict
                    [
                        Composition.BatchSizeVariable, string batchSize
                    ]
            )
            .Build()

    ServiceCollection()
        .AddSingleton<NpgsqlDataSource>(source)
        .AddSingleton<IConfiguration>(configuration)
        .BuildServiceProvider()

/// Один тик против настоящей базы. Размер пачки задаётся явно: сценарий, которому
/// важна граница пачки, не должен зависеть от значения по умолчанию.
let runTick (source: NpgsqlDataSource) (port: RecordingPort) (batchSize: int) =
    use services = provider source batchSize
    let deps = Composition.buildDeps services port.Publish

    execute deps CancellationToken.None
    |> Async.AwaitTask
    |> Async.RunSynchronously

let reportOf (outcome: TickOutcome) =
    match outcome with
    | TickOutcome.Ran report -> report
    | TickOutcome.TurnBusy -> failwith "the tick reported a busy turn"
