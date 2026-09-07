namespace Meetups.Domain

open System

/// Ось жизненного цикла (ADR-022). В срезе достижимо только Planned: команд
/// перехода к «состоялась» и «отменена» здесь нет, но словарь ADR-031 полный.
type MeetupLifecycle =
    | Planned
    | Held
    | Cancelled

/// Ось видимости (ADR-022). Пара «Hidden и заполненная отметка первой публикации»
/// означает снятую с публикации сходку; в срезе такое состояние недостижимо, но
/// отметка заводится сразу — задним числом восстановить её невозможно.
type MeetupVisibility =
    | Hidden
    | Visible

/// Снимок состояния после события: тело строки журнала и ответ команд (ADR-031).
/// Определён отдельно от состояния намеренно — поля сегодня совпадают, но
/// раздельные определения не дают служебной колонке хранилища автоматически стать
/// изменением контракта. Обе оси состояния объявлены здесь же: снимок — первый
/// файл, которому они нужны.
type MeetupSnapshot =
    {
        Id: MeetupId
        Author: PersonId
        Title: string
        Description: string
        Venue: string
        Kind: string
        CalendarLink: string
        Schedule: Schedule
        Lifecycle: MeetupLifecycle
        Visibility: MeetupVisibility
        FirstPublishedAt: DateTimeOffset option
        Version: int64
    }
