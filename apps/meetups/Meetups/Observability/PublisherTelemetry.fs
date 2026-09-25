/// Наблюдаемость адаптера публикации отдельно от reader: попытка публикации в NATS,
/// её исход и время до ack сервера.
///
/// Метр свой, а не инструменты внутри `meetups.outbox`. Бэклог и лаг описывают
/// очередь журнала и не меняются от смены транспорта; время ack и классы отказа
/// описывают шину. Сложенные в один метр, они не дали бы отличить «очередь растёт,
/// потому что NATS не отвечает» от «очередь растёт, потому что тик не успевает».
module Meetups.Observability.PublisherTelemetry

open System
open System.Collections.Generic
open System.Diagnostics.Metrics

[<Literal>]
let MeterName = "meetups.publisher"

let private meter = new Meter(MeterName)

/// Попытки с исходом в атрибуте `result`. Счётчик на все исходы, а не по счётчику
/// на исход: доля отказов читается одним запросом, и новый класс отказа не требует
/// нового инструмента.
let private attempts = meter.CreateCounter<int64>("meetups.publisher.attempts")

/// Секунды, как у остальных метрик времени сервиса (см. DispatchTelemetry).
let private duration =
    meter.CreateHistogram<double>("meetups.publisher.duration_seconds")

/// Исход одной попытки. `duplicate` — ack с пометкой повтора: сервер узнал
/// `Nats-Msg-Id` внутри окна стрима, и это подтверждение, а не отказ.
let observe (result: string) (elapsed: TimeSpan) =
    let tag = KeyValuePair<string, obj>("result", result)
    attempts.Add(1L, tag)
    duration.Record(elapsed.TotalSeconds, tag)
