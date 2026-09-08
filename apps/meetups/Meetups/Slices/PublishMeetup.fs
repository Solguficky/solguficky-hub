/// Срез «опубликовать». Команда сформулирована как целевое состояние, поэтому
/// повтор на уже видимой сходке — успех без события (ADR-031, I5), а не отказ.
module Meetups.Slices.PublishMeetup

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        PerformedBy: PersonId
    }

[<RequireQualifiedAccess; NoComparison>]
type PublishMeetupError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, PublishMeetupError>> =
    task {
        let! existing = deps.Load command.Id
        let state = Meetup.restore existing

        // Часы читаются один раз на команду: этот же момент становится отметкой
        // первой публикации в состоянии и `occurred_at` в конверте события. Два
        // чтения дали бы одному факту два времени.
        let now = deps.Now()

        match Meetup.decidePublish now state with
        | Error error -> return Error(PublishMeetupError.Domain error)
        | Ok None ->
            match existing with
            | Some snapshot -> return Ok snapshot
            | None -> return invalidOp "the domain reported a visible meetup without loading one"
        | Ok(Some event) ->
            let envelope: MeetupStore.EventEnvelope =
                {
                    EventId = deps.NewEventId()
                    PerformedBy = command.PerformedBy
                    OccurredAt = now
                }

            match! deps.Commit envelope state event with
            | Ok snapshot -> return Ok snapshot
            | Error MeetupStore.VersionConflict -> return Error PublishMeetupError.Conflict
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
