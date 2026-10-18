/// Поведение фоновой границы при ненастроенном порте. База и таймер здесь не нужны:
/// обещание ветки ровно в том, что до них дело не доходит.
module Meetups.OutboxDispatchWorkerTests

open System
open System.Collections.Concurrent
open System.Threading
open Meetups.Slices.DispatchMeetupEvents
open Meetups.TestKit
open Meetups.Transport
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Logging
open Swensen.Unquote
open Xunit

/// Контейнер пуст намеренно: ветка `Unconfigured` не собирает зависимости, и любое
/// обращение к источнику соединений упало бы здесь отказом разрешения.
let private services () = ServiceCollection().BuildServiceProvider() :> IServiceProvider

let private configuration () = ConfigurationBuilder().Build() :> IConfiguration

let private started (port: Port) =
    let records = ConcurrentQueue<LogRecord>()

    use factory =
        LoggerFactory.Create(fun builder ->
            builder.AddProvider(new RecordingLoggerProvider(records))
            |> ignore
        )

    let worker =
        new OutboxDispatchWorker(port, services (), configuration (), factory.CreateLogger<OutboxDispatchWorker>())

    worker.StartAsync(CancellationToken.None).GetAwaiter().GetResult()

    // Возврат StartAsync не означает, что ExecuteAsync отработал: хост не обязан
    // выполнять его синхронно, и тест, который читал записи сразу, ловил пустую
    // очередь. Ждём саму задачу воркера — у ветки без порта она уже завершена, и
    // ожидание не может повиснуть.
    match worker.ExecuteTask with
    | null -> ()
    | execution -> execution.GetAwaiter().GetResult()

    worker.StopAsync(CancellationToken.None).GetAwaiter().GetResult()
    (worker :> IDisposable).Dispose()

    List.ofSeq records

[<Fact>]
let ``An unconfigured port leaves one record about the state of the process`` () =
    let records = started Port.Unconfigured

    let record = List.exactlyOne records

    // Запись о жизненном цикле процесса, а не об операции: длительности и результата
    // у неё нет (logging.md).
    test <@ record.Level = LogLevel.Information @>
    test <@ record.Fields.TryFind "dispatch" = Some "unconfigured" @>
    test <@ record.Fields.TryFind "service" = Some "meetups" @>
    test <@ record.Fields.ContainsKey "duration_us" = false @>
    test <@ record.Fields.ContainsKey "result" = false @>

[<Fact>]
let ``An unconfigured port never starts a tick`` () =
    let records = started Port.Unconfigured

    // Тик собрал бы зависимости из пустого контейнера и упал бы, а цикл повторял бы
    // отказ каждые несколько секунд. Единственная запись — и есть доказательство, что
    // цикл не начинался.
    test
        <@
            records
            |> List.forall (fun record -> record.Fields.ContainsKey "operation" |> not)
        @>
