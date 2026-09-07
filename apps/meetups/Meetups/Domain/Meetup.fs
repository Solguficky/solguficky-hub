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
    | TitleRequiredForPublication
    | DraftBelongsToAnotherAuthor

/// Состояние агрегата (ADR-031). Представление приватно, поэтому запись копией вне
/// этого файла не собирается: единственный путь изменения поля — применение
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

module Meetup =

    // Применение события — единственный путь изменения полей. У создания нет
    // состояния «до», поэтому у него своя функция: пара «состояния нет и событие
    // изменения» остаётся невыразимой, а мёртвая ветка в match не заводится.

    /// Черновик заводится пустым: пустые тексты, NoDate, Planned, Hidden, без
    /// отметки первой публикации. Версия агрегата начинается с единицы.
    let applyCreated (id: MeetupId) (author: PersonId) : Meetup =
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

    let applyChanged (meetup: Meetup) (change: MeetupChange) : Meetup =
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
    let applyPublished (meetup: Meetup) (at: DateTimeOffset) : Meetup =
        { meetup with
            Visibility = Visible
            FirstPublishedAt = meetup.FirstPublishedAt |> Option.orElse (Some at)
            Version = meetup.Version + 1L
        }

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
        (existing: Meetup option)
        : Result<MeetupEvent option, DomainError> =
        match existing with
        | None -> Ok(Some(MeetupCreated(id, author)))
        | Some meetup when meetup.Author = author -> Ok None
        | Some _ -> Error DraftBelongsToAnotherAuthor

    // Двум командам ниже отказать нечем: атрибуты и расписание тотальны, а стоячего
    // инварианта «видимая сходка имеет заголовок» в срезе нет. Result у них поэтому
    // не заводится — вариант отказа без единой ветки нечем проверить, а граница
    // получила бы невозможный случай в исчерпывающем match. Состояние параметром
    // остаётся: форма решения общая для четырёх команд, и редактирование после
    // публикации вернёт ему смысл, не меняя сигнатуру.

    let decideChangeAttributes (attributes: MeetupAttributes) (_meetup: Meetup) : MeetupEvent =
        MeetupChanged(AttributesChanged attributes)

    let decideSetSchedule (schedule: Schedule) (_meetup: Meetup) : MeetupEvent = MeetupChanged(ScheduleChanged schedule)

    /// I5 проверяется раньше I4: уже видимая сходка успешна независимо от остального,
    /// потому что команда сформулирована как целевое состояние и повтор не ошибка.
    /// I4: заголовок из одних пробелов заголовком не считается.
    let decidePublish (now: DateTimeOffset) (meetup: Meetup) : Result<MeetupEvent option, DomainError> =
        match meetup.Visibility with
        | Visible -> Ok None
        | Hidden when String.IsNullOrWhiteSpace meetup.Title -> Error TitleRequiredForPublication
        | Hidden -> Ok(Some(MeetupPublished now))
