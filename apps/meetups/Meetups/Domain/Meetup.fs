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

/// Поводы строки журнала. Тип называет повод; тело строки — снимок,
/// его даёт Meetup.toSnapshot от уже применённого состояния. Конверт строки
/// (event_id, occurred_at, performed_by) заполняет оболочка: домену он не нужен ни
/// для одного инварианта.
type MeetupEvent =
    | MeetupCreated of id: MeetupId * author: PersonId
    | MeetupChanged of MeetupChange
    | MeetupPublished of at: DateTimeOffset
    | MeetupUnpublished
    | MeetupRepublished
    | MeetupCancelled
    | MeetupMaterialAttached of material: MeetupMaterial
    | MeetupMaterialRemoved of materialId: MaterialId

/// Отклонённый переход состояния. Отказа по правам здесь нет: право действовать не
/// является инвариантом перехода, и состояние в решении о нём не участвует. Само
/// правило при этом остаётся доменным и живёт в Domain/Access.fs со своим типом
/// отказа — сюда оно не переезжает.
///
/// TransitionNotAllowed означает «из текущего состояния в запрошенное не попасть» —
/// и когда пару отвергла таблица оси, и когда переход закрыло состояние второй оси.
/// Для отвечающего наружу это один класс отказа: различать причину внутри него —
/// дело детали статуса, а не отдельного варианта.
///
/// С TitleRequiredForPublication они намеренно не сливаются: первый означает «не
/// попасть», второй — «переход разрешён, но данных не хватает». ADR-022 разводит
/// единственное условие полноты и переходные инварианты, и у человека на них разные
/// действия: слить их значило бы отнять у него это различие.
type DomainError =
    | MeetupNotFound
    | DraftBelongsToAnotherAuthor
    | TitleRequiredForPublication
    | TransitionNotAllowed

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
            Materials: MeetupMaterial list
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
            Materials = []
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

    let private setVisibility visibility (meetup: Meetup) : Meetup =
        { meetup with
            Visibility = visibility
            Version = meetup.Version + 1L
        }

    let private cancel (meetup: Meetup) : Meetup =
        { meetup with
            Lifecycle = Cancelled
            Version = meetup.Version + 1L
        }

    /// Материал входит в состояние только применением события: позицию и авторство
    /// привязки приносит событие, а не команда записи. Остальные материалы удаление
    /// не трогает — их позиции остаются теми же, и порядок от него не зависит.
    let private attachMaterial (material: MeetupMaterial) (meetup: Meetup) : Meetup =
        { meetup with
            Materials = meetup.Materials @ [ material ]
            Version = meetup.Version + 1L
        }

    let private removeMaterial (materialId: MaterialId) (meetup: Meetup) : Meetup =
        { meetup with
            Materials =
                meetup.Materials
                |> List.filter (fun material -> material.Id <> materialId)
            Version = meetup.Version + 1L
        }

    /// Применение события — единственный путь появления и изменения полей.
    /// Результат всегда существующая сходка: каждый повод оставляет её на месте.
    let apply (state: MeetupState) (event: MeetupEvent) : Meetup =
        match state, event with
        | Initial, MeetupCreated(id, author) -> create id author
        | Existing meetup, MeetupChanged changed -> change meetup changed
        | Existing meetup, MeetupPublished at -> publish meetup at
        | Existing meetup, MeetupUnpublished -> setVisibility Hidden meetup
        | Existing meetup, MeetupRepublished -> setVisibility Visible meetup
        | Existing meetup, MeetupCancelled -> cancel meetup
        | Existing meetup, MeetupMaterialAttached material -> attachMaterial material meetup
        | Existing meetup, MeetupMaterialRemoved materialId -> removeMaterial materialId meetup
        | Initial, MeetupChanged _
        | Initial, MeetupPublished _
        | Initial, MeetupUnpublished
        | Initial, MeetupRepublished
        | Initial, MeetupCancelled
        | Initial, MeetupMaterialAttached _
        | Initial, MeetupMaterialRemoved _
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
            Materials = meetup.Materials
            Lifecycle = meetup.Lifecycle
            Visibility = meetup.Visibility
            FirstPublishedAt = meetup.FirstPublishedAt
            Version = meetup.Version
        }

    /// Восстановление состояния из снимка — обратная функция к toSnapshot. Живёт
    /// здесь по той же причине, что и apply: представление приватно, и собрать
    /// запись снаружи невозможно. Снимок взят входом потому, что другого описания
    /// сходки целиком в домене нет. Это осознанная связь двух определений, которые
    /// ADR-031 развёл: в день, когда у состояния появится поле, отсутствующее в
    /// снимке, вход придётся заменить собственным типом восстановления.
    let rehydrate (snapshot: MeetupSnapshot) : Meetup =
        {
            Id = snapshot.Id
            Author = snapshot.Author
            Title = snapshot.Title
            Description = snapshot.Description
            Venue = snapshot.Venue
            Kind = snapshot.Kind
            CalendarLink = snapshot.CalendarLink
            Schedule = snapshot.Schedule
            Materials = snapshot.Materials
            Lifecycle = snapshot.Lifecycle
            Visibility = snapshot.Visibility
            FirstPublishedAt = snapshot.FirstPublishedAt
            Version = snapshot.Version
        }

    /// Отсутствие строки в хранилище — это Initial, а не особый случай оболочки:
    /// команда к несуществующей сходке остаётся обычным отказом домена, и решать
    /// это должен домен, а не проверка перед его вызовом.
    let restore (snapshot: MeetupSnapshot option) : MeetupState =
        match snapshot with
        | None -> Initial
        | Some snapshot -> Existing(rehydrate snapshot)

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
        | Existing meetup when meetup.Lifecycle = Cancelled -> Error TransitionNotAllowed
        | Existing _ -> Ok(MeetupChanged(AttributesChanged attributes))

    let decideSetSchedule (schedule: Schedule) (state: MeetupState) : Result<MeetupEvent, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup when meetup.Lifecycle = Cancelled -> Error TransitionNotAllowed
        | Existing _ -> Ok(MeetupChanged(ScheduleChanged schedule))

    /// Порядок проверок наблюдаем снаружи, поэтому он зафиксирован здесь, а не
    /// выведен из удобства записи.
    ///
    /// I5 идёт первым: уже видимая сходка успешна независимо от остального, потому
    /// что команда сформулирована как целевое состояние и повтор не ошибка. Отмена
    /// его не перебивает: у видимой сходки переходить некуда, и отказывать не в чем.
    /// Приоритет осознанный и закреплён тестом — отмена оси видимости не трогает,
    /// поэтому отменённая видимая сходка достижима, и отказ на ней подменил бы
    /// успешный повтор отклонённым переходом. Дальше таблица оси видимости —
    /// единственное место, где решается сама допустимость перехода. Затем жизненный
    /// цикл: отменённую сходку не публикуют, и это условие команды поверх
    /// разрешённого перехода, а не переход, поэтому в таблицу оно не уехало. I4
    /// проверяется последним намеренно: иначе отменённый черновик без заголовка
    /// отвечал бы «нужен заголовок» и прятал настоящую причину отказа.
    let decidePublish (now: DateTimeOffset) (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match MeetupTransitions.visibility meetup.Visibility Visible with
            | TransitionOutcome.AlreadyThere -> Ok None
            | TransitionOutcome.Rejected -> Error TransitionNotAllowed
            | TransitionOutcome.Allowed ->
                // Held не закрывает публикацию: ретроспективно заведённую прошедшую
                // сходку показать сообществу нужно. Отменённая — закрывает: отмена
                // описывает ход сходки, а не способ её спрятать (PER-197).
                match meetup.Lifecycle with
                | Cancelled -> Error TransitionNotAllowed
                | Planned
                | Held ->
                    if String.IsNullOrWhiteSpace meetup.Title then
                        Error TitleRequiredForPublication
                    else
                        match meetup.FirstPublishedAt with
                        | None -> Ok(Some(MeetupPublished now))
                        | Some _ -> Ok(Some MeetupRepublished)

    /// Порядок проверок тот же, что у публикации, и по той же причине. I5 идёт
    /// первым: уже скрытая сходка успешна независимо от остального, отменённая в том
    /// числе — прятать в ней нечего. Дальше таблица оси видимости, и только потом
    /// жизненный цикл.
    ///
    /// Отмена закрывает снятие ровно потому же, почему закрывает публикацию: она
    /// описывает ход сходки, а не способ её спрятать (PER-197). Без этого условия
    /// пара «отменить, затем снять» уводила бы сходку туда, откуда её не возвращает
    /// ни одна команда: публикацию отменённой скрытой отклоняет decidePublish, и
    /// извещение об отмене исчезало бы из человеческих чтений навсегда.
    let decideUnpublish (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match MeetupTransitions.visibility meetup.Visibility Hidden with
            | TransitionOutcome.AlreadyThere -> Ok None
            | TransitionOutcome.Rejected -> Error TransitionNotAllowed
            | TransitionOutcome.Allowed ->
                match meetup.Lifecycle with
                | Cancelled -> Error TransitionNotAllowed
                | Planned
                | Held -> Ok(Some MeetupUnpublished)

    let decideCancel (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match MeetupTransitions.lifecycle meetup.Lifecycle Cancelled with
            | TransitionOutcome.AlreadyThere -> Ok None
            | TransitionOutcome.Allowed -> Ok(Some MeetupCancelled)
            | TransitionOutcome.Rejected -> Error TransitionNotAllowed

    /// Порядок проверок тот же, что у публикации, и по той же причине: повтор с тем
    /// же идентификатором материала идёт первым. Идентификатор материала — ключ
    /// идемпотентности, как `id` у создания черновика: повтор возвращает текущий
    /// снимок без события и не плодит второй материал. Уже прикреплённый материал
    /// означает достигнутое целевое состояние независимо от жизненного цикла —
    /// отмена его не отменяет, поэтому повтор успешен и на отменённой сходке.
    ///
    /// Позиция назначается решением, а не применением: она зависит от текущего
    /// состояния. Новый материал встаёт в конец коллекции — вставку в середину
    /// выразит отдельная команда порядка (RFC-004), в срез не входящая.
    let decideAttachMaterial
        (boundBy: PersonId)
        (materialId: MaterialId)
        (title: string)
        (source: MaterialSource)
        (state: MeetupState)
        : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup when
            meetup.Materials
            |> List.exists (fun material -> material.Id = materialId)
            ->
            Ok None
        | Existing meetup when meetup.Lifecycle = Cancelled -> Error TransitionNotAllowed
        | Existing meetup ->
            let position =
                meetup.Materials
                |> List.fold (fun next material -> max next material.Position) 0
                |> (+) 1

            Ok(
                Some(
                    MeetupMaterialAttached
                        {
                            Id = materialId
                            Position = position
                            Title = title
                            Source = source
                            BoundBy = boundBy
                        }
                )
            )

    /// Команда сформулирована как целевое состояние, поэтому отсутствие материала —
    /// успех без события, а не отказ: повтор после потерянного ответа безопасен.
    /// Порядок проверок тот же, что у прикрепления: достигнутое целевое состояние
    /// идёт первым, и только затем жизненный цикл. Отмена закрывает удаление так же,
    /// как закрывает правку атрибутов (PER-197): материалы — обычное редактирование
    /// сведений о сходке, а не способ её обойти.
    let decideRemoveMaterial (materialId: MaterialId) (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup when
            not (
                meetup.Materials
                |> List.exists (fun material -> material.Id = materialId)
            )
            ->
            Ok None
        | Existing meetup when meetup.Lifecycle = Cancelled -> Error TransitionNotAllowed
        | Existing _ -> Ok(Some(MeetupMaterialRemoved materialId))
