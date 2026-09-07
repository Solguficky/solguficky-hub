namespace Meetups.TestKit

open System
open System.Collections.Concurrent
open System.Collections.Generic
open Microsoft.Extensions.Logging

/// Одна запись лога, разобранная до структурных полей: каркас из
/// docs/standards/observability/logging.md проверяется по именам полей, а не по
/// отформатированному тексту.
type LogRecord =
    {
        Level: LogLevel
        Fields: Map<string, string>
        Exception: exn option
    }

/// Именованный тип, а не object expression: object expression не реализует
/// generic-методы интерфейса, а Log и BeginScope у ILogger именно такие.
type private RecordingLogger(sink: ConcurrentQueue<LogRecord>) =

    static let noScope =
        { new IDisposable with
            member _.Dispose() = ()
        }

    interface ILogger with
        member _.BeginScope(_state: 'TState) = noScope

        member _.IsEnabled(_level: LogLevel) = true

        member _.Log
            (level: LogLevel, _eventId: EventId, state: 'TState, exn: exn, _formatter: Func<'TState, exn, string>)
            =
            let fields =
                match box state with
                | :? seq<KeyValuePair<string, obj>> as pairs ->
                    pairs
                    |> Seq.map (fun pair -> pair.Key, string pair.Value)
                    |> Map.ofSeq
                | _ -> Map.empty

            sink.Enqueue
                {
                    Level = level
                    Fields = fields
                    Exception = Option.ofObj exn
                }

/// Провайдер, который складывает записи в память. Живёт в TestKit, потому что
/// нужен обоим тестовым проектам: unit-тесты границы читают им поля напрямую,
/// интеграционный подключает его к работающему хосту через
/// ILoggerFactory.AddProvider, оставляя Host.build тем же composition root.
type RecordingLoggerProvider(sink: ConcurrentQueue<LogRecord>) =
    interface ILoggerProvider with
        member _.CreateLogger(_category: string) = RecordingLogger(sink)
        member _.Dispose() = ()
