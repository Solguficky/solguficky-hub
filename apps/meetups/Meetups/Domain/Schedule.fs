namespace Meetups.Domain

open System

/// Локальные дата и время сообщества: часовой пояс задаётся конфигурацией и
/// применяется при интерпретации, а не при записи (ADR-031). Минутную точность
/// контракта держит граница: TimeOnly умеет секунды, которых в схеме нет.
type LocalDateTime =
    {
        Date: DateOnly
        Time: TimeOnly
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
