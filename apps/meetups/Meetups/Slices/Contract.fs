/// Перевод между сгенерированным контрактом meetups.v1 и доменным словарём.
///
/// Общий модуль срезов, а не Infrastructure/: функция знает два контракта сразу и
/// переводит один в другой, а MeetupSnapshot — целевая модель отображения, а не
/// словарь значений. Оба проверочных вопроса норматива дают «нет», и файл
/// принадлежит срезам.
///
/// Здесь лежит только то, у чего сегодня несколько потребителей: смотрящий,
/// идентификатор и снимок нужны всем четырём командам. Разбор расписания и
/// атрибутов остаётся в своих срезах — там у них ровно один потребитель.
///
/// Контрактные типы пишутся квалифицированно: `open Meetups.V1` молча переопределил
/// бы MeetupSnapshot в сигнатурах, потому что доменный тип назван так же.
module Meetups.Slices.Contract

open System
open Meetups.Domain

/// Отказ разбора запроса. Общим типом ошибок приложения не является: он называет
/// неуспех одной функции перевода — так же, как MeetupStore.VersionConflict называет
/// неуспех записи. Ветвиться по нему негде, весь тип отображается ровно в
/// INVALID_ARGUMENT, поэтому проверку полноты он не убивает.
///
/// Значение поля сюда не попадает: там произвольный ввод вызывающей стороны, а текст
/// уходит и клиенту, и в запись границы (logging.md).
type InvalidRequest =
    {
        Field: string
        Problem: string
    }

/// Конструктор отказа. Метки полей записи видны только внутри этого модуля, а
/// собирать отказ приходится и в срезах, которые разбирают своё поле сами.
let invalid (field: string) (problem: string) : InvalidRequest =
    {
        Field = field
        Problem = problem
    }

module Inbound =

    /// Канонический вид строки и версию UUID проверяет граница сервиса, а не домен —
    /// обещание из Domain/Ids.fs, которое исполняется здесь.
    ///
    /// Сравнение с `Guid.ToString "D"` закрывает и регистр, и дефисы одним шагом:
    /// TryParseExact "D" принимает верхний регистр, а канонический вид нижний.
    let private uuidV7 (field: string) (value: string) : Result<Guid, InvalidRequest> =
        match Guid.TryParseExact(value, "D") with
        | true, parsed when value = parsed.ToString "D" ->
            // Версия и вариант проверяются вместе: строка с верной версией и чужим
            // вариантом каноническим UUIDv7 по RFC 9562 не является, а Guid её
            // разбирает — формат "D" о смысле битов ничего не знает.
            //
            // Guid.Variant отдаёт сам ниббл, а не номер варианта, поэтому сравнение
            // идёт по двум старшим битам: RFC 9562 — это 10xx, то есть 8..B.
            if parsed.Version = 7 && parsed.Variant >>> 2 = 0b10 then
                Ok parsed
            else
                Error(invalid field "must be a UUIDv7")
        | _ -> Error(invalid field "must be a canonical lowercase UUID with hyphens")

    let meetupId (value: string) : Result<MeetupId, InvalidRequest> = uuidV7 "id" value |> Result.map MeetupId

    /// Человек, о котором спрашивает другой сервис, приходит одним идентификатором —
    /// без ролей: их Meetups спрашивает у Identity сам (ADR-051).
    let identityId (value: string) : Result<PersonId, InvalidRequest> =
        uuidV7 "identity_id" value |> Result.map PersonId

    /// Принимаемые отношения, в отличие от ролей смотрящего, неизвестного значения
    /// не прощают: пустой набор, UNSPECIFIED и значение вне словаря — ошибка
    /// вызывающего, и молчаливый отказ спрятал бы её (ADR-051, п. 2). Отбросить
    /// неизвестное здесь значило бы сузить набор, который вызывающий объявил.
    let acceptedRelations (values: Meetups.V1.MeetupRelation seq) : Result<Set<MeetupRelation>, InvalidRequest> =
        let field = "accepted_relations"

        let relation (value: Meetups.V1.MeetupRelation) =
            match value with
            | Meetups.V1.MeetupRelation.CommunityAdministrator -> Some CommunityAdministrator
            | _ -> None

        let parsed = values |> Seq.map relation |> List.ofSeq

        if List.isEmpty parsed then Error(invalid field "must not be empty")
        elif List.contains None parsed then Error(invalid field "must contain only known relations")
        else Ok(parsed |> List.choose id |> Set.ofList)

    let materialId (value: string) : Result<MaterialId, InvalidRequest> =
        uuidV7 "material_id" value
        |> Result.map MaterialId

    /// Разбор календарной даты и местного времени переехал сюда из среза расписания,
    /// когда у него появился второй потребитель — назначение момента публикации.
    /// Значения остаются локальными: часовой пояс применяется при интерпретации, а
    /// не при разборе (ADR-031), поэтому ни одна из функций зоны не знает.
    let calendarDate (field: string) (value: Meetups.V1.CalendarDate) : Result<DateOnly, InvalidRequest> =
        if isNull (box value) then
            Error(invalid field "is required")
        else
            try
                Ok(DateOnly(value.Year, value.Month, value.Day))
            with :? ArgumentOutOfRangeException ->
                Error(invalid field "is not a calendar date")

    let localTime (field: string) (value: Meetups.V1.LocalTime) : Result<LocalTime, InvalidRequest> =
        if isNull (box value) then
            Error(invalid field "is required")
        elif
            value.Hours < 0
            || value.Hours > 23
            || value.Minutes < 0
            || value.Minutes > 59
        then
            Error(invalid field "must be a time of day at minute precision")
        else
            TimeOnly(value.Hours, value.Minutes)
            |> LocalTime.create
            |> Result.mapError (fun _ -> invalid field "must be a time of day at minute precision")

    let localDateTime (field: string) (value: Meetups.V1.LocalDateTime) : Result<LocalDateTime, InvalidRequest> =
        if isNull (box value) then
            Error(invalid field "is required")
        else
            match calendarDate $"{field}.date" value.Date, localTime $"{field}.time" value.Time with
            | Ok date, Ok time ->
                Ok
                    {
                        Date = date
                        Time = time
                    }
            | Error invalid, _
            | _, Error invalid -> Error invalid

    /// Ожидаемая версия состояния, из которого принято решение (PER-78). Поле
    /// обязательное: в proto3 скаляр без presence не отличает пропуск от нуля, но
    /// нулевой версии у сходки не существует — версия начинается с единицы. Поэтому
    /// отсутствие и ноль одинаково отвергаются, а не читаются как «последняя версия».
    let expectedVersion (value: int64) : Result<int64, InvalidRequest> =
        if value > 0L then Ok value else Error(invalid "expected_version" "must be a positive aggregate version")

    /// Неизвестная роль отбрасывается, а не отвергается. Схема сама объявляет
    /// GLOBAL_ROLE_UNSPECIFIED значением «роль неизвестна потребителю», и неизвестная
    /// роль ничего не разрешает — отбрасывание остаётся fail-closed. Отказ по ней
    /// превратил бы расширение словаря ролей в Identity в отказ обслуживания у
    /// Meetups до согласованного деплоя обоих сервисов.
    ///
    /// Известные роли переходят в доменный словарь целиком: решения читают только
    /// Administrator, но словарь типа совпадает со словарём контракта.
    let private role (value: Identity.V1.GlobalRole) : GlobalRole option =
        match value with
        | Identity.V1.GlobalRole.Maintainer -> Some Maintainer
        | Identity.V1.GlobalRole.Admin -> Some Administrator
        | Identity.V1.GlobalRole.Member -> Some Member
        | Identity.V1.GlobalRole.Public -> Some Public
        | _ -> None

    let viewer (value: Meetups.V1.Viewer) : Result<Viewer, InvalidRequest> =
        if isNull (box value) then
            Error(invalid "viewer" "is required")
        else
            uuidV7 "viewer.identity_id" value.IdentityId
            |> Result.map (fun identity ->
                {
                    IdentityId = PersonId identity
                    Roles = value.GlobalRoles |> Seq.choose role |> Set.ofSeq
                }
            )

module Outbound =

    let private calendarDate (date: DateOnly) : Meetups.V1.CalendarDate =
        Meetups.V1.CalendarDate(Year = date.Year, Month = date.Month, Day = date.Day)

    let private localDateTime (value: LocalDateTime) : Meetups.V1.LocalDateTime =
        let time = LocalTime.value value.Time

        Meetups.V1.LocalDateTime(
            Date = calendarDate value.Date,
            Time = Meetups.V1.LocalTime(Hours = time.Hour, Minutes = time.Minute)
        )

    let private dateValue (value: DateValue) : Meetups.V1.DateValue =
        match value with
        | Day date -> Meetups.V1.DateValue(Day = calendarDate date)
        | DayStart moment -> Meetups.V1.DateValue(DayStart = localDateTime moment)
        | Interval interval ->
            Meetups.V1.DateValue(
                Interval =
                    Meetups.V1.LocalInterval(
                        Start = localDateTime (LocalInterval.start interval),
                        End = localDateTime (LocalInterval.finish interval)
                    )
            )

    let schedule (value: Schedule) : Meetups.V1.Schedule =
        match value with
        | NoDate -> Meetups.V1.Schedule(NoDate = Meetups.V1.NoDate())
        | Tentative date -> Meetups.V1.Schedule(Tentative = dateValue date)
        | Fixed date -> Meetups.V1.Schedule(Fixed = dateValue date)

    let lifecycle (value: MeetupLifecycle) : Meetups.V1.MeetupLifecycle =
        match value with
        | Planned -> Meetups.V1.MeetupLifecycle.Planned
        | Held -> Meetups.V1.MeetupLifecycle.Held
        | Cancelled -> Meetups.V1.MeetupLifecycle.Cancelled

    let visibility (value: MeetupVisibility) : Meetups.V1.MeetupVisibility =
        match value with
        | Hidden -> Meetups.V1.MeetupVisibility.Hidden
        | Visible -> Meetups.V1.MeetupVisibility.Visible

    let materialSource (value: MaterialSource) : Meetups.V1.MeetupMaterialSource =
        match value with
        | MessageLink link -> Meetups.V1.MeetupMaterialSource(MessageLink = link)
        | FileId fileId -> Meetups.V1.MeetupMaterialSource(FileId = fileId)

    /// Материал на проводе несёт только то, что видит потребитель: порядок
    /// передаётся порядком repeated-поля, а авторство привязки остаётся внутренним —
    /// это единственное поле материала, указывающее на человека (PER-200).
    let material (value: MeetupMaterial) : Meetups.V1.MeetupMaterial =
        let (MaterialId id) = value.Id

        Meetups.V1.MeetupMaterial(Id = id.ToString "D", Title = value.Title, Source = materialSource value.Source)

    /// Краткие сведения списков. Живут здесь, а не в срезе: потребителей двое —
    /// актуальный список и архив, — и разошедшиеся копии отрисовки отличались бы
    /// только тем, какой из списков её забыл обновить.
    let summary (value: Meetups.Domain.MeetupSnapshot) : Meetups.V1.MeetupSummary =
        let (MeetupId id) = value.Id

        Meetups.V1.MeetupSummary(
            Id = id.ToString "D",
            Title = value.Title,
            Venue = value.Venue,
            Schedule = schedule value.Schedule,
            Lifecycle = lifecycle value.Lifecycle,
            Visibility = visibility value.Visibility
        )

    let snapshot (value: Meetups.Domain.MeetupSnapshot) : Meetups.V1.MeetupSnapshot =
        let (MeetupId id) = value.Id
        let (PersonId author) = value.Author

        let contract =
            Meetups.V1.MeetupSnapshot(
                // "D" даёт каноническую нижнюю регистровую форму с дефисами — ту же,
                // которую граница требует на входе.
                Id = id.ToString "D",
                Author = author.ToString "D",
                Title = value.Title,
                Description = value.Description,
                Venue = value.Venue,
                Kind = value.Kind,
                CalendarLink = value.CalendarLink,
                Schedule = schedule value.Schedule,
                Lifecycle = lifecycle value.Lifecycle,
                Visibility = visibility value.Visibility,
                Version = value.Version
            )

        contract.Materials.AddRange(value.Materials |> Seq.map material)

        // Единственное настоящее отсутствие в сообщении: unset означает «никогда не
        // публиковалась». UtcDateTime, а не сам DateTimeOffset: формат "o" у второго
        // печатает смещение +00:00, а контракт требует RFC 3339 UTC с Z.
        match value.FirstPublishedAt with
        | Some at -> contract.FirstPublishedAt <- at.ToUniversalTime().UtcDateTime.ToString "o"
        | None -> ()

        // Момент отложенной публикации читается тем же правилом: назначенный момент
        // уезжает мгновением, а в каком поясе его показать, решает вызывающая
        // сторона. Локальная пара осталась во входе команды — там она и есть выбор
        // человека.
        match value.ScheduledPublishAt with
        | Some at -> contract.ScheduledPublishAt <- at.ToUniversalTime().UtcDateTime.ToString "o"
        | None -> ()

        contract

    /// Состояние в теле события. Отдельное сообщение, а не `MeetupSnapshot`, —
    /// решение контракта (PER-206); отображение же одно по смыслу, поэтому
    /// собирается из тех же помощников и тех же правил моментов, что снимок выше.
    /// Версии в нём нет: она значение конверта, и две копии одного числа могли бы
    /// разойтись.
    let state (value: Meetups.Domain.MeetupSnapshot) : Meetups.V1.MeetupState =
        let (MeetupId id) = value.Id
        let (PersonId author) = value.Author

        let contract =
            Meetups.V1.MeetupState(
                Id = id.ToString "D",
                Author = author.ToString "D",
                Title = value.Title,
                Description = value.Description,
                Venue = value.Venue,
                Kind = value.Kind,
                CalendarLink = value.CalendarLink,
                Schedule = schedule value.Schedule,
                Lifecycle = lifecycle value.Lifecycle,
                Visibility = visibility value.Visibility
            )

        contract.Materials.AddRange(value.Materials |> Seq.map material)

        match value.FirstPublishedAt with
        | Some at -> contract.FirstPublishedAt <- at.ToUniversalTime().UtcDateTime.ToString "o"
        | None -> ()

        match value.ScheduledPublishAt with
        | Some at -> contract.ScheduledPublishAt <- at.ToUniversalTime().UtcDateTime.ToString "o"
        | None -> ()

        contract
