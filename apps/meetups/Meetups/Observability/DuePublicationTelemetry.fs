/// Наблюдаемость отложенной публикации: размер набора и просрочка старейшего
/// момента как уровни, исходы попыток как счётчики.
///
/// Свой метр, а не вложенный модуль в `DispatchTelemetry`: тот назван по outbox, и
/// публикация по расписанию к журналу-очереди отношения не имеет. Общего метра
/// «фоновая работа Meetups» не заводится — он заставил бы обе границы знать друг о
/// друге ради имени.
///
/// Уровни выражены Gauge по той же причине, что и у соседа: «сколько сейчас ждёт
/// публикации» и «сколько опубликовано всего» — разные вопросы, и набор из приращений
/// не складывается. Значения ставятся изнутри тика (push): ObservableGauge ходил бы в
/// базу на каждый scrape, и цена наблюдения перестала бы зависеть от нашего интервала.
///
/// Модуль принимает примитивы и ничего не знает о срезе — так он остаётся ниже
/// границы в порядке компиляции и не превращается в зеркало отчёта тика.
module Meetups.Observability.DuePublicationTelemetry

open System
open System.Diagnostics.Metrics

/// Единственное определение имени метра: его же передаёт в `AddMeter` composition
/// root, поэтому опечатка, из-за которой инструменты не экспортируются, невозможна по
/// построению.
[<Literal>]
let MeterName = "meetups.publication"

let private meter = new Meter(MeterName)

/// Сколько сходок ждут публикации прямо сейчас — прямой ответ на «не растёт ли
/// набор».
let private due = meter.CreateGauge<int64>("meetups.publication.due")

/// Секунды, а не микросекунды: у метрик единица времени секунда, у записи лога —
/// `duration_us`. Расхождение намеренное, каждая сторона держит свою дисциплину.
let private oldestDueAge =
    meter.CreateGauge<double>("meetups.publication.oldest_due_age_seconds")

let private published = meter.CreateCounter<int64>("meetups.publication.published")

/// Проигранная гонка за строку: её изменил кто-то другой. Счётчик, а не уровень, —
/// это событие, а не состояние набора.
let private claimed = meter.CreateCounter<int64>("meetups.publication.claimed")

/// Отклонённый доменом переход. Именно он, оставаясь ненулевым от тика к тику,
/// объясняет растущий `oldest_due_age_seconds`.
let private blocked = meter.CreateCounter<int64>("meetups.publication.blocked")

/// Неожиданный отказ на одной сходке. Отдельно от `blocked`, потому что различаются
/// не уровнем, а природой: отклонённый переход ждёт человека, оборванная запись —
/// починки или следующего тика.
let private failed = meter.CreateCounter<int64>("meetups.publication.failed")

/// Пустой набор пишется нулём в обоих уровнях, и это расходится с записью лога, где
/// возраст опускается. Расхождение следует из разной природы носителей: запись лога —
/// событие, и отсутствующее поле читается как «возраста не было». Уровень читается
/// последним записанным значением, поэтому пропуск означает «осталось прежним», и
/// выгребенный за час набор навсегда показывал бы час.
let observe
    (backlog: int64)
    (age: TimeSpan option)
    (publishedNow: int)
    (claimedNow: int)
    (blockedNow: int)
    (failedNow: int)
    =
    due.Record backlog

    oldestDueAge.Record(
        match age with
        | Some value -> value.TotalSeconds
        | None -> 0.0
    )

    if publishedNow > 0 then
        published.Add(int64 publishedNow)

    if claimedNow > 0 then
        claimed.Add(int64 claimedNow)

    if blockedNow > 0 then
        blocked.Add(int64 blockedNow)

    if failedNow > 0 then
        failed.Add(int64 failedNow)
