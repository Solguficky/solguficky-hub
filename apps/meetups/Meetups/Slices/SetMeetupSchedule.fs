/// Срез «задать расписание». Расписание приходит одним собранным значением: его
/// структурные инварианты закрыты типом (перевёрнутый интервал невыразим), поэтому
/// отказа сборки значения здесь уже быть не может — он остаётся на границе сервиса.
module Meetups.Slices.SetMeetupSchedule

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        PerformedBy: PersonId
        Schedule: Schedule
    }

[<RequireQualifiedAccess; NoComparison>]
type SetMeetupScheduleError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, SetMeetupScheduleError>> =
    task {
        let! existing = deps.Load command.Id
        let state = Meetup.restore existing

        match Meetup.decideSetSchedule command.Schedule state with
        | Error error -> return Error(SetMeetupScheduleError.Domain error)
        | Ok event ->
            let envelope: MeetupStore.EventEnvelope =
                {
                    EventId = deps.NewEventId()
                    PerformedBy = command.PerformedBy
                    OccurredAt = deps.Now()
                }

            match! deps.Commit envelope state event with
            | Ok snapshot -> return Ok snapshot
            | Error MeetupStore.VersionConflict -> return Error SetMeetupScheduleError.Conflict
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
