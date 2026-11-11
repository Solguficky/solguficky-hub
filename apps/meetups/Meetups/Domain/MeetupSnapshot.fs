namespace Meetups.Domain

open System

/// Ось жизненного цикла (ADR-022). Все три значения достижимы: «состоялась» даёт
/// MarkMeetupHeld, отмену — CancelMeetup, а прошедшая архивом не становится —
/// архив производен от расписания, а не от четвёртого значения оси (PER-229).
type MeetupLifecycle =
    | Planned
    | Held
    | Cancelled

/// Ось видимости (ADR-022). Пара «Hidden и заполненная отметка первой публикации»
/// означает снятую с публикации сходку; команды PER-197 достигают его, а
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
        Materials: MeetupMaterial list
        Lifecycle: MeetupLifecycle
        Visibility: MeetupVisibility
        FirstPublishedAt: DateTimeOffset option
        ScheduledPublishAt: DateTimeOffset option
        /// Состав организаторов в порядке вступления (ADR-076, п. 3). Автор в нём с
        /// рождения сходки, но остаётся автором, выйдя из состава; администратор как
        /// держатель `manage_meetups` в состав не записывается, пока его не назначили
        /// явно, — в нём он только как автор сходки, которую сам завёл.
        Organizers: PersonId list
        Version: int64
    }
