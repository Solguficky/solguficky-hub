/// Наблюдаемость фоновой публикации: бэклог и возраст старейшей неотправленной
/// записи как уровни, публикации и отказы как счётчики.
///
/// Уровни выражены Gauge, а не счётчиком: «сколько сейчас не отправлено» и «сколько
/// отправлено всего» — разные вопросы, и сложить бэклог из приращений нельзя.
/// Значения ставятся изнутри тика (push), а не читаются колбэком: ObservableGauge
/// ходил бы в базу на каждый scrape, и цена наблюдения перестала бы зависеть от
/// нашего интервала опроса.
///
/// Модуль ничего не знает о срезе и принимает примитивы. Так он остаётся ниже
/// границы в порядке компиляции и не превращается в зеркало отчёта тика.
module Meetups.Observability.DispatchTelemetry

open System
open System.Diagnostics.Metrics

/// Единственное определение имени метра: его же передаёт в `AddMeter` composition
/// root. Опечатка, из-за которой инструменты не экспортируются, невозможна по
/// построению, поэтому отдельного теста на совпадение имён нет.
[<Literal>]
let MeterName = "meetups.outbox"

let private meter = new Meter(MeterName)

let private pending = meter.CreateGauge<int64>("meetups.outbox.pending")

/// Секунды, а не микросекунды: у метрик единица времени секунда, у записи лога —
/// `duration_us`. Каждая сторона держит свою дисциплину, и это расхождение
/// намеренное, а не недосмотр.
let private oldestPendingAge =
    meter.CreateGauge<double>("meetups.outbox.oldest_pending_age_seconds")

let private published = meter.CreateCounter<int64>("meetups.outbox.published")

let private declined = meter.CreateCounter<int64>("meetups.outbox.declined")

/// Наблюдённые повторы: публикация, чья отметка не задела строки, потому что её уже
/// отметил кто-то другой. Счётчик, а не уровень: это событие, а не состояние
/// очереди.
let private repeats = meter.CreateCounter<int64>("meetups.outbox.repeats")

/// Возраст пустой очереди пишется нулём, и это расходится с записью лога, где поле
/// опускается. Расхождение намеренное и следует из разной природы носителей: запись
/// лога — событие, и отсутствующее поле в ней читается как «возраста не было».
/// Уровень же читается последним записанным значением, поэтому пропуск не означает
/// «пусто» — он означает «осталось прежним», и выгребенная за час очередь навсегда
/// показывала бы час. Ложное «ноль секунд» здесь безопаснее ложного «час»:
/// рядом стоит `pending`, который на пустой очереди тоже ноль и снимает двусмысленность.
let observe (backlog: int64) (age: TimeSpan option) (publishedNow: int) (declinedNow: int) (repeatsNow: int) =
    pending.Record backlog

    oldestPendingAge.Record(
        match age with
        | Some value -> value.TotalSeconds
        | None -> 0.0
    )

    if publishedNow > 0 then
        published.Add(int64 publishedNow)

    if declinedNow > 0 then
        declined.Add(int64 declinedNow)

    if repeatsNow > 0 then
        repeats.Add(int64 repeatsNow)
