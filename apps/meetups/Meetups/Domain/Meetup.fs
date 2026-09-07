namespace Meetups.Domain

open System

/// Вход команды «изменить атрибуты»: все пять информационных атрибутов целиком.
/// Эта форма делает «одно событие, а не событие на каждое поле» свойством типа, а
/// не дисциплиной автора. Атрибуты тотальны: пустая строка — легитимное значение
/// «не указано», поэтому операции «очистить» не существует (ADR-031).
type MeetupAttributes =
    {
        Title: string
        Description: string
        Venue: string
        Kind: string
        CalendarLink: string
    }

/// Что именно изменилось. Обе команды изменения дают один повод журнала —
/// «сходка изменена», — потому что у расписания нет своего типа события (ADR-031).
type MeetupChange =
    | AttributesChanged of MeetupAttributes
    | ScheduleChanged of Schedule

/// Три повода строки журнала (ADR-031). Тип называет повод; тело строки — снимок,
/// его даёт Meetup.toSnapshot от уже применённого состояния. Конверт строки
/// (event_id, occurred_at, performed_by) заполняет оболочка: домену он не нужен ни
/// для одного инварианта.
type MeetupEvent =
    | MeetupCreated of id: MeetupId * author: PersonId
    | MeetupChanged of MeetupChange
    | MeetupPublished of at: DateTimeOffset

/// Отклонённый переход состояния. Отказа по правам здесь нет и не будет: право
/// действовать — политика границы, а не бизнес-инвариант.
type DomainError =
    | MeetupNotFound
    | DraftBelongsToAnotherAuthor
    | TitleRequiredForPublication

/// Сходка (ADR-031). Представление приватно, поэтому запись копией вне этого файла
/// не собирается: единственный путь появления и изменения полей — применение
/// события (ADR-024). Читается состояние снимком.
type Meetup =
    private
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

/// Состояние, из которого принимается решение и в котором применяется событие.
/// Состояние «до» есть у каждого события, включая создание: у него это Initial,
/// «сходки ещё нет». Пустой сходки с идентификатором и нулевой версией при этом не
/// существует — поля живут только в Existing.
type MeetupState =
    | Initial
    | Existing of Meetup

module Meetup =

    /// Черновик заводится пустым: пустые тексты, NoDate, Planned, Hidden, без
    /// отметки первой публикации. Версия агрегата начинается с единицы.
    let private create (id: MeetupId) (author: PersonId) : Meetup =
        {
            Id = id
            Author = author
            Title = ""
            Description = ""
            Venue = ""
            Kind = ""
            CalendarLink = ""
            Schedule = NoDate
            Lifecycle = Planned
            Visibility = Hidden
            FirstPublishedAt = None
            Version = 1L
        }

    let private change (meetup: Meetup) (change: MeetupChange) : Meetup =
        let changed =
            match change with
            | AttributesChanged attributes ->
                { meetup with
                    Title = attributes.Title
                    Description = attributes.Description
                    Venue = attributes.Venue
                    Kind = attributes.Kind
                    CalendarLink = attributes.CalendarLink
                }
            | ScheduleChanged schedule ->
                { meetup with
                    Schedule = schedule
                }

        { changed with
            Version = meetup.Version + 1L
        }

    /// I6: отметка первой публикации ставится один раз и после этого не меняется.
    let private publish (meetup: Meetup) (at: DateTimeOffset) : Meetup =
        { meetup with
            Visibility = Visible
            FirstPublishedAt = meetup.FirstPublishedAt |> Option.orElse (Some at)
            Version = meetup.Version + 1L
        }

    /// Применение события — единственный путь появления и изменения полей.
    /// Результат всегда существующая сходка: каждый повод оставляет её на месте.
    let apply (state: MeetupState) (event: MeetupEvent) : Meetup =
        match state, event with
        | Initial, MeetupCreated(id, author) -> create id author
        | Existing meetup, MeetupChanged changed -> change meetup changed
        | Existing meetup, MeetupPublished at -> publish meetup at
        | Initial, MeetupChanged _
        | Initial, MeetupPublished _
        | Existing _, MeetupCreated _ ->
            // Событие решено не из этого состояния. Ни одно решение такой пары не
            // возвращает, поэтому это нарушение внутреннего контракта оболочки, а не
            // отклонённый переход домена: исключение, а не вариант DomainError.
            invalidOp "the event was decided from another state"

    /// Единственный путь чтения состояния наружу.
    let toSnapshot (meetup: Meetup) : MeetupSnapshot =
        {
            Id = meetup.Id
            Author = meetup.Author
            Title = meetup.Title
            Description = meetup.Description
            Venue = meetup.Venue
            Kind = meetup.Kind
            CalendarLink = meetup.CalendarLink
            Schedule = meetup.Schedule
            Lifecycle = meetup.Lifecycle
            Visibility = meetup.Visibility
            FirstPublishedAt = meetup.FirstPublishedAt
            Version = meetup.Version
        }

    // Решения: состояние и все недетерминированные факты приходят значениями.

    /// I7: автор задаётся при создании и дальше не меняется ни одной командой.
    /// Повтор тем же автором — успех без события. Повтор чужим автором отклоняется,
    /// иначе он подтвердил бы существование чужого черновика; единый ответ
    /// «не найдено» собирает граница (ADR-031).
    let decideCreateDraft
        (author: PersonId)
        (id: MeetupId)
        (state: MeetupState)
        : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Ok(Some(MeetupCreated(id, author)))
        | Existing meetup when meetup.Author = author -> Ok None
        | Existing _ -> Error DraftBelongsToAnotherAuthor

    /// Атрибуты и расписание тотальны, а стоячего инварианта «видимая сходка имеет
    /// заголовок» в срезе нет: единственный отказ этих двух команд — несуществующая
    /// сходка.
    let decideChangeAttributes (attributes: MeetupAttributes) (state: MeetupState) : Result<MeetupEvent, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing _ -> Ok(MeetupChanged(AttributesChanged attributes))

    let decideSetSchedule (schedule: Schedule) (state: MeetupState) : Result<MeetupEvent, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing _ -> Ok(MeetupChanged(ScheduleChanged schedule))

    /// I5 проверяется раньше I4: уже видимая сходка успешна независимо от остального,
    /// потому что команда сформулирована как целевое состояние и повтор не ошибка.
    /// I4: заголовок из одних пробелов заголовком не считается.
    let decidePublish (now: DateTimeOffset) (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match meetup.Visibility with
            | Visible -> Ok None
            | Hidden when String.IsNullOrWhiteSpace meetup.Title -> Error TitleRequiredForPublication
            | Hidden -> Ok(Some(MeetupPublished now))
