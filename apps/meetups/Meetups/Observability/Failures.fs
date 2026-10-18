/// Счётчик отказов сервиса из docs/standards/observability/logging.md: каждый отказ
/// увеличивает `solguficky.failures` с атрибутами `service` и `error_category`.
///
/// Общим модулем он стал, когда у него появилась вторая граница. До фоновой
/// публикации счётчик жил приватным полем внутри `BoundaryLog`, и это было верно:
/// потребитель был один. Второй потребитель — не повод для абстракции, а ровно то
/// условие, после которого норматив срезов разрешает общий модуль.
module Meetups.Observability.Failures

open System.Collections.Generic
open System.Diagnostics.Metrics

/// Имя метра задано нормативом и совпадает с тем, что ServiceDefaults передаёт в
/// `AddMeter`. Отдельной регистрации в Host не требует.
[<Literal>]
let MeterName = "solguficky.failures"

/// Имя сервиса — константа его сборки, а не метка сборщика логов: значение внутри
/// записи переживает смену транспорта доставки. Живёт здесь, потому что его заполняет
/// каждая граница сервиса, а границ уже две.
[<Literal>]
let Service = "meetups"

let private meter = new Meter(MeterName)

let private counter = meter.CreateCounter<int64>(MeterName)

let count (category: string) =
    counter.Add(
        1L,
        KeyValuePair<string, obj>("service", Service),
        KeyValuePair<string, obj>("error_category", category)
    )
