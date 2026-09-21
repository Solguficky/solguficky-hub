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
    | MeetupPublicationScheduled of at: DateTimeOffset
    | MeetupPublicationCancelled
    | MeetupCancelled
    | MeetupMaterialAttached of material: MeetupMaterial
    | MeetupMaterialRemoved of materialId: MaterialId
    | MeetupHeld

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
    // Момент отложенной публикации уже прошёл: выбор человека неисполним по
    // времени, а не запрещён состоянием сходки. От TransitionNotAllowed он
    // отличается тем же, чем TitleRequiredForPublication: у человека на них
    // разные действия — переспросить время или посмотреть состояние сходки.
    | PublicationMomentInThePast

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
            ScheduledPublishAt: DateTimeOffset option
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
            ScheduledPublishAt = None
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
    /// Момент отложенной публикации публикация забирает себе: назначенное время
    /// наступило, и оставленное поле противоречило бы и снимку, и схеме
    /// (`meetups_scheduled_publish_only_when_hidden`). Обнуление живёт здесь, а не в
    /// SQL, потому что момент — часть состояния, и другой путь его изменения
    /// запрещён (ADR-024).
    let private publish (meetup: Meetup) (at: DateTimeOffset) : Meetup =
        { meetup with
            Visibility = Visible
            FirstPublishedAt = meetup.FirstPublishedAt |> Option.orElse (Some at)
            ScheduledPublishAt = None
            Version = meetup.Version + 1L
        }

    let private setVisibility visibility (meetup: Meetup) : Meetup =
        { meetup with
            Visibility = visibility
            Version = meetup.Version + 1L
        }

    /// Момент отложенной публикации — признак, а не ось: состояния «запланирована
    /// публикация» не существует, и отмена сходки очищает поле тем же переходом,
    /// что закрывает обе команды редактирования (PER-204).
    let private cancel (meetup: Meetup) : Meetup =
        { meetup with
            Lifecycle = Cancelled
            ScheduledPublishAt = None
            Version = meetup.Version + 1L
        }

    let private schedulePublication (at: DateTimeOffset) (meetup: Meetup) : Meetup =
        { meetup with
            ScheduledPublishAt = Some at
            Version = meetup.Version + 1L
        }

    let private cancelScheduledPublication (meetup: Meetup) : Meetup =
        { meetup with
            ScheduledPublishAt = None
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

    /// Жизненный цикл двигается на конечную стадию, независимая ось видимости не
    /// трогается: скрытая состоявшаяся остаётся скрытой, а видимая — видимой.
    let private hold (meetup: Meetup) : Meetup =
        { meetup with
            Lifecycle = Held
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
        | Existing meetup, MeetupPublicationScheduled at -> schedulePublication at meetup
        | Existing meetup, MeetupPublicationCancelled -> cancelScheduledPublication meetup
        | Existing meetup, MeetupCancelled -> cancel meetup
        | Existing meetup, MeetupMaterialAttached material -> attachMaterial material meetup
        | Existing meetup, MeetupMaterialRemoved materialId -> removeMaterial materialId meetup
        | Existing meetup, MeetupHeld -> hold meetup
        | Initial, MeetupChanged _
        | Initial, MeetupPublished _
        | Initial, MeetupUnpublished
        | Initial, MeetupRepublished
        | Initial, MeetupPublicationScheduled _
        | Initial, MeetupPublicationCancelled
        | Initial, MeetupCancelled
        | Initial, MeetupMaterialAttached _
        | Initial, MeetupMaterialRemoved _
        | Initial, MeetupHeld
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
            ScheduledPublishAt = meetup.ScheduledPublishAt
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
            ScheduledPublishAt = snapshot.ScheduledPublishAt
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

    /// I9: назначить момент можно только скрытой сходке, и только в будущем.
    /// Порядок проверок наблюдаем снаружи и потому зафиксирован: сначала состояние
    /// (видимая и отменённая закрывают команду), потом значение — тем же правилом,
    /// по которому публикация проверяет переход раньше полноты заголовка. Иначе
    /// назначение на прошедший момент отменённой сходке отвечало бы «время прошло»
    /// и прятало настоящую причину отказа.
    ///
    /// Повтор того же момента — успех без события, как у целевых команд (I5):
    /// кнопка, нажатая дважды, не пишет второй строки журнала. Другой момент
    /// скрытой сходки — замена с событием, а не второй назначенный момент.
    /// I5 проверяется раньше «момент прошёл»: иначе повтор уже истёкшего, но ещё
    /// не забранного воркером момента отвечал бы отказом вместо повторного успеха.
    let decideSchedulePublication
        (now: DateTimeOffset)
        (at: DateTimeOffset)
        (state: MeetupState)
        : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match meetup.Visibility with
            | Visible -> Error TransitionNotAllowed
            | Hidden ->
                match meetup.Lifecycle with
                | Cancelled -> Error TransitionNotAllowed
                | Planned
                | Held ->
                    if meetup.ScheduledPublishAt = Some at then Ok None
                    elif at <= now then Error PublicationMomentInThePast
                    else Ok(Some(MeetupPublicationScheduled at))

    /// Отмена сформулирована как целевое состояние «запланированной публикации
    /// нет», поэтому отказ у неё ровно один — несуществующая сходка. Момент,
    /// который уже прошёл, а воркер ещё не забрал, отменяется так же, как будущий:
    /// человек передумал до того, как публикация случилась, а гонку с воркером
    /// разрешает версия строки, а не проверка часов здесь. У видимой сходки
    /// момента не бывает, поэтому её отмена — успех без события.
    let decideCancelScheduledPublication (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match meetup.ScheduledPublishAt with
            | None -> Ok None
            | Some _ -> Ok(Some MeetupPublicationCancelled)

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

    /// Перевод в «состоялась» — ручное действие администратора (ADR-022), повтор
    /// на уже состоявшейся сходке — успех без события. Отменённая не переводится:
    /// обе конечные стадии оси терминальны. Ни расписание, ни видимость в решении
    /// не участвуют, поэтому ретроспективная отметка и скрытая сходка разрешены;
    /// полнота атрибутов проверяется только на переходе к публикации.
    let decideMarkHeld (state: MeetupState) : Result<MeetupEvent option, DomainError> =
        match state with
        | Initial -> Error MeetupNotFound
        | Existing meetup ->
            match MeetupTransitions.lifecycle meetup.Lifecycle Held with
            | TransitionOutcome.AlreadyThere -> Ok None
            | TransitionOutcome.Allowed -> Ok(Some MeetupHeld)
            | TransitionOutcome.Rejected -> Error TransitionNotAllowed

    /// Достигнуто ли целевое состояние события текущим состоянием. Вопрос задаёт
    /// безопасный повтор: команда, принятая из показанного снимка, могла разойтись
    /// с записанной версией, но её цель уже в силе — тогда PER-78 разрешает вернуть
    /// текущий снимок успехом без события, а не отвечать конфликтом.
    ///
    /// Решением команды этот вопрос не выражается: у двух правок пустой diff —
    /// всё равно событие (ADR-031), поэтому их цель сравнивается полями, а не
    /// повторным вызовом `decide*`. Для переходов ответ совпадает с «уже там» из
    /// таблиц осей, но берётся тем же сравнением состояния: различать нужно
    /// состояние, а не повторное решение. Отмена, случившаяся между показанным
    /// снимком и перечитыванием, для переходов уже учтена самими осями (I5
    /// пропускает её на уже достигнутой видимости, как и `decidePublish`/
    /// `decideUnpublish`), а для изменения атрибутов и расписания — нет: у этих
    /// команд отмена отклоняет любое совпадение полей (`decideChangeAttributes`,
    /// `decideSetSchedule`), поэтому и здесь она исключает «цель достигнута» —
    /// иначе отменённая concurrently сходка получала бы тихий успех вместо
    /// TransitionNotAllowed.
    let targetReached (event: MeetupEvent) (state: MeetupState) : bool =
        match state, event with
        | Initial, _ -> false
        | Existing meetup, MeetupCreated(_, author) -> meetup.Author = author
        | Existing meetup, MeetupChanged(AttributesChanged attributes) ->
            meetup.Lifecycle <> Cancelled
            && meetup.Title = attributes.Title
            && meetup.Description = attributes.Description
            && meetup.Venue = attributes.Venue
            && meetup.Kind = attributes.Kind
            && meetup.CalendarLink = attributes.CalendarLink
        | Existing meetup, MeetupChanged(ScheduleChanged schedule) ->
            meetup.Lifecycle <> Cancelled
            && meetup.Schedule = schedule
        | Existing meetup, MeetupPublished _
        | Existing meetup, MeetupRepublished -> meetup.Visibility = Visible
        | Existing meetup, MeetupUnpublished -> meetup.Visibility = Hidden
        | Existing meetup, MeetupCancelled -> meetup.Lifecycle = Cancelled
        | Existing meetup, MeetupHeld -> meetup.Lifecycle = Held
        | Existing meetup, MeetupPublicationScheduled at ->
            meetup.Visibility = Hidden
            && meetup.Lifecycle <> Cancelled
            && meetup.ScheduledPublishAt = Some at
        | Existing meetup, MeetupPublicationCancelled -> meetup.ScheduledPublishAt = None
        // Материал уже целевого состояния — успех независимо от жизненного цикла
        // (decideAttachMaterial/decideRemoveMaterial проверяют это первым, раньше
        // Cancelled), поэтому здесь тоже нет проверки Lifecycle.
        | Existing meetup, MeetupMaterialAttached material ->
            meetup.Materials
            |> List.exists (fun existing -> existing.Id = material.Id)
        | Existing meetup, MeetupMaterialRemoved materialId ->
            not (
                meetup.Materials
                |> List.exists (fun existing -> existing.Id = materialId)
            )
