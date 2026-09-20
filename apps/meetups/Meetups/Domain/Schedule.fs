namespace Meetups.Domain

open System

/// Отказ построения минутного времени.
type LocalTimeError = MorePreciseThanMinute

/// Локальное время сообщества с минутной точностью — I8. Приватная форма
/// не позволяет обойти инвариант новой границе ввода.
type LocalTime = private LocalTime of TimeOnly

module LocalTime =

    let create (value: TimeOnly) : Result<LocalTime, LocalTimeError> =
        if value.Ticks % TimeSpan.TicksPerMinute <> 0L then Error MorePreciseThanMinute else Ok(LocalTime value)

    let value (LocalTime value) = value

/// Локальные дата и время сообщества: часовой пояс задаётся конфигурацией и
/// применяется при интерпретации, а не при записи (ADR-031).
type LocalDateTime =
    {
        Date: DateOnly
        Time: LocalTime
    }

/// Отказ построения значения расписания. Отделён от DomainError намеренно: это
/// несобираемое значение, а не отклонённый переход состояния, и агрегат о таком
/// входе не узнаёт вовсе. Отображение обоих отказов в коды gRPC закрепляет
/// транспортный слой — таблица в docs/architecture/integration.md различает
/// «клиент собрал запрос неправильно» и «домен не позволяет переход».
type ScheduleError = IntervalEndsBeforeItStarts

/// Интервал, окончание которого не раньше начала — I2. Представление приватно,
/// поэтому перевёрнутый интервал невыразим, а не отлавливается проверкой.
/// I3 достаётся формой: обе границы несут и дату, и время, разноточной пары нет.
type LocalInterval =
    private
        {
            Start: LocalDateTime
            End: LocalDateTime
        }

module LocalInterval =

    let create (start: LocalDateTime) (finish: LocalDateTime) : Result<LocalInterval, ScheduleError> =
        if finish < start then
            Error IntervalEndsBeforeItStarts
        else
            {
                Start = start
                End = finish
            }
            |> Ok

    let start (interval: LocalInterval) = interval.Start

    let finish (interval: LocalInterval) = interval.End

/// Форма и точность даты (ADR-022, ADR-031). I1: время без даты невыразимо —
/// такой формы в сумме просто нет.
type DateValue =
    | Day of DateOnly
    | DayStart of LocalDateTime
    | Interval of LocalInterval

/// Расписание одним значением. «Даты нет» — форма NoDate, а не отсутствие значения:
/// пустого расписания в домене не существует.
type Schedule =
    | NoDate
    | Tentative of DateValue
    | Fixed of DateValue

/// Явная группа расписания для порядка чтения (ADR-022). Dated объявлен раньше
/// Undated намеренно: сходки с датой показываются первыми, а отсутствие даты не
/// полагается на поведение СУБД при NULL.
[<RequireQualifiedAccess>]
type ScheduleOrder =
    | Dated of date: DateOnly * time: TimeOnly option
    | Undated

module Schedule =

    /// Ключ порядка не различает tentative и fixed: обе формы сообщают одну и ту
    /// же дату человеку. День без времени идёт раньше времени в тот же день, а
    /// равные ключи намеренно не получают tie-break по идентификатору (ADR-022).
    let order (schedule: Schedule) : ScheduleOrder =
        let dateOrder (value: DateValue) =
            match value with
            | Day date -> ScheduleOrder.Dated(date, None)
            | DayStart moment -> ScheduleOrder.Dated(moment.Date, Some(LocalTime.value moment.Time))
            | Interval interval ->
                let start = LocalInterval.start interval
                ScheduleOrder.Dated(start.Date, Some(LocalTime.value start.Time))

        match schedule with
        | NoDate -> ScheduleOrder.Undated
        | Tentative value
        | Fixed value -> dateOrder value
