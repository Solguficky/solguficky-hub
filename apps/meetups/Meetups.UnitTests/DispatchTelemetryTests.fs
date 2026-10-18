/// Доходят ли наблюдения тика до инструментов с ожидаемыми именами.
///
/// Слушатель рукописный, а не из тестового пакета: инструментов четыре, вопрос к ним
/// один, и `MeterListener` из BCL отвечает на него без новой зависимости. Порядок
/// выбора test double норматив задаёт именно так — маленький handwritten fake раньше,
/// чем библиотека.
module Meetups.DispatchTelemetryTests

open System
open System.Collections.Generic
open System.Diagnostics.Metrics
open Meetups.Observability
open Swensen.Unquote
open Xunit

/// Слушает только свой метр: в процессе живут ещё инструменты ServiceDefaults и
/// счётчик отказов, и без фильтра тест читал бы чужие измерения.
type private RecordedMeasurements() =
    let taken = ResizeArray<string * double>()
    let listener = new MeterListener()

    do
        listener.InstrumentPublished <-
            (fun instrument _ ->
                if instrument.Meter.Name = DispatchTelemetry.MeterName then
                    listener.EnableMeasurementEvents instrument
            )

        listener.SetMeasurementEventCallback<int64>(
            MeasurementCallback<int64>(fun instrument value _ _ -> taken.Add(instrument.Name, double value))
        )

        listener.SetMeasurementEventCallback<double>(
            MeasurementCallback<double>(fun instrument value _ _ -> taken.Add(instrument.Name, value))
        )

        listener.Start()

    member _.Taken = List.ofSeq taken

    member this.ValueOf(name: string) =
        this.Taken
        |> List.tryPick (fun (instrument, value) -> if instrument = name then Some value else None)

    interface IDisposable with
        member _.Dispose() = listener.Dispose()

[<Fact>]
let ``The backlog and the age of its oldest record reach their instruments`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 12L (Some(TimeSpan.FromSeconds 90.0)) 3 0 0

    test <@ recorded.ValueOf "meetups.outbox.pending" = Some 12.0 @>
    test <@ recorded.ValueOf "meetups.outbox.oldest_pending_age_seconds" = Some 90.0 @>
    test <@ recorded.ValueOf "meetups.outbox.published" = Some 3.0 @>

[<Fact>]
let ``An empty backlog reports a zero size and a zero age`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 0L None 0 0 0

    // Уровень читается последним записанным значением, поэтому пропуск означал бы не
    // «пусто», а «осталось прежним»: выгребенная за час очередь навсегда показывала бы
    // час, и алерт по возрасту не погас бы. Запись лога здесь ведёт себя иначе и поле
    // опускает — там это событие, а не уровень.
    test <@ recorded.ValueOf "meetups.outbox.pending" = Some 0.0 @>
    test <@ recorded.ValueOf "meetups.outbox.oldest_pending_age_seconds" = Some 0.0 @>

[<Fact>]
let ``A tick that published nothing adds nothing to the counters`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 4L (Some(TimeSpan.FromSeconds 1.0)) 0 0 0

    test <@ recorded.ValueOf "meetups.outbox.published" = None @>
    test <@ recorded.ValueOf "meetups.outbox.declined" = None @>

[<Fact>]
let ``A declined publication reaches the declined counter`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 4L (Some(TimeSpan.FromSeconds 1.0)) 1 1 0

    test <@ recorded.ValueOf "meetups.outbox.declined" = Some 1.0 @>

[<Fact>]
let ``An observed repeat reaches the repeats counter`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 4L (Some(TimeSpan.FromSeconds 1.0)) 2 0 1

    test <@ recorded.ValueOf "meetups.outbox.repeats" = Some 1.0 @>

[<Fact>]
let ``A tick without repeats adds nothing to the repeats counter`` () =
    use recorded = new RecordedMeasurements()

    DispatchTelemetry.observe 4L (Some(TimeSpan.FromSeconds 1.0)) 2 0 0

    test <@ recorded.ValueOf "meetups.outbox.repeats" = None @>
