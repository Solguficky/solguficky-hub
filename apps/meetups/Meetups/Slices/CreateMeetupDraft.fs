/// Срез «завести черновик». Идентификатор генерирует вызывающая сторона, он же
/// ключ идемпотентности (ADR-031): повтор тем же автором возвращает текущий снимок
/// и события не порождает, повтор чужим автором отклоняется, чтобы не подтвердить
/// существование чужого черновика.
///
/// Срез свёрнут в один модуль: собственных отображений у него нет, а пустой файл
/// типов ради симметрии с соседом — шум, а не структура.
module Meetups.Slices.CreateMeetupDraft

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        PerformedBy: PersonId
    }

/// Свой error DU у каждого среза. Одинаковый набор вариантов у четырёх команд
/// сегодня — совпадение, а не абстракция: отображение в коды отказов у них уже
/// разное, и общий тип заставил бы каждый срез разбирать невозможные для него
/// случаи. RequireQualifiedAccess здесь не украшение: без него одноимённые Conflict
/// соседних срезов перекрывали бы друг друга по правилу последнего открытого модуля.
[<RequireQualifiedAccess; NoComparison>]
type CreateMeetupDraftError =
    | Domain of DomainError
    | Conflict

[<NoEquality; NoComparison>]
type Deps =
    {
        Load: MeetupId -> Task<MeetupSnapshot option>
        Commit:
            MeetupStore.EventEnvelope
                -> MeetupState
                -> MeetupEvent
                -> Task<Result<MeetupSnapshot, MeetupStore.VersionConflict>>
        Now: unit -> DateTimeOffset
        NewEventId: unit -> Guid
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, CreateMeetupDraftError>> =
    task {
        let! existing = deps.Load command.Id
        let state = Meetup.restore existing

        match Meetup.decideCreateDraft command.PerformedBy command.Id state with
        | Error error -> return Error(CreateMeetupDraftError.Domain error)
        | Ok None ->
            // Успех без события: сходка уже заведена этим же автором. Записи нет,
            // поэтому и транзакции нет — возвращается то, что уже лежит в базе.
            match existing with
            | Some snapshot -> return Ok snapshot
            | None -> return invalidOp "the domain reported an existing draft without loading one"
        | Ok(Some event) ->
            let envelope: MeetupStore.EventEnvelope =
                {
                    EventId = deps.NewEventId()
                    PerformedBy = command.PerformedBy
                    OccurredAt = deps.Now()
                }

            match! deps.Commit envelope state event with
            | Ok snapshot -> return Ok snapshot
            | Error MeetupStore.VersionConflict -> return Error CreateMeetupDraftError.Conflict
    }

/// Composition root среза: здесь заканчивается DI. Ниже живут только функции и
/// значения, поэтому workflow не знает ни про контейнер, ни про строку подключения.
/// Каждый срез собирает свои зависимости сам: единый набор функций на весь сервис
/// вернул бы связность, ради устранения которой выбраны срезы.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps (services: IServiceProvider) : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        {
            Load = MeetupStore.load source
            Commit = MeetupStore.commit source
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            NewEventId = Guid.CreateVersion7
        }
