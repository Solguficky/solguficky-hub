/// Оболочка среза «задать расписание». У этой команды нет ветки «успех без
/// события»: расписание тотально, и единственный её отказ — несуществующая сходка.
module Meetups.SliceTests.SetMeetupScheduleWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.SetMeetupSchedule
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e003"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.fixedNow
        NewEventId = fun () -> eventId
    }

let private run (deps: Deps) (schedule: Schedule) =
    execute
        deps
        {
            Id = Sample.meetupId
            PerformedBy = Sample.authorId
            Schedule = schedule
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private loading (snapshot: MeetupSnapshot option) (deps: Deps) =
    { deps with
        Load = fun _ -> Task.FromResult snapshot
    }

[<Fact>]
let ``A schedule is written as a change event carrying the new value`` () =
    let written = ResizeArray()

    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))

    let deps =
        { loaded with
            Commit =
                fun envelope state event ->
                    written.Add(envelope, state, event)

                    Meetup.apply state event
                    |> Meetup.toSnapshot
                    |> Ok
                    |> Task.FromResult
        }

    let result = run deps (Fixed Sample.day)
    let envelope, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ state = Existing Sample.titled @>
    test <@ event = MeetupChanged(ScheduleChanged(Fixed Sample.day)) @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.OccurredAt = Sample.fixedNow @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Schedule) = Ok(Fixed Sample.day)
        @>

/// Расписание тотально: возврат к «даты нет» — такое же изменение, как и любое
/// другое, и оно тоже порождает событие.
[<Fact>]
let ``Clearing the date is a change like any other`` () =
    let written = ResizeArray()

    let loaded =
        stub
        |> loading (
            Some
                { Meetup.toSnapshot Sample.titled with
                    Schedule = Fixed Sample.day
                }
        )

    let deps =
        { loaded with
            Commit =
                fun _ state event ->
                    written.Add event

                    Meetup.apply state event
                    |> Meetup.toSnapshot
                    |> Ok
                    |> Task.FromResult
        }

    let result = run deps NoDate

    test
        <@
            List.ofSeq written = [
                MeetupChanged(ScheduleChanged NoDate)
            ]
        @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Schedule) = Ok NoDate
        @>

[<Fact>]
let ``Scheduling an absent meetup is rejected without writing`` () =
    let result = run (stub |> loading None) (Fixed Sample.day)

    test <@ result = Error(SetMeetupScheduleError.Domain MeetupNotFound) @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))

    let deps =
        { loaded with
            Commit =
                fun _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps (Fixed Sample.day) = Error SetMeetupScheduleError.Conflict @>
