/// Оболочка среза «назначить момент публикации». Здесь проверяется то, чего не
/// видно в домене: локальная пара становится мгновением по поясу сообщества, а
/// местное время, которого в поясе не существует, отвергается до обращения к
/// хранилищу.
module Meetups.SliceTests.ScheduleMeetupPublicationWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.ScheduleMeetupPublication
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e023"

/// Пояс сообщества в тестах — Москва: перехода на летнее время у неё нет, поэтому
/// интерпретация проверяется смещением, а не календарём. Поведение на переходах
/// проверяется отдельно, на Берлине.
let private moscow = TimeZoneInfo.FindSystemTimeZoneById "Europe/Moscow"
let private berlin = TimeZoneInfo.FindSystemTimeZoneById "Europe/Berlin"

let private localDateTime (date: DateOnly) (hours: int) (minutes: int) =
    {
        Date = date
        Time =
            LocalTime.create (TimeOnly(hours, minutes))
            |> Result.defaultWith (fun _ -> failwith "the test time is more precise than a minute")
    }

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.fixedNow
        NewEventId = fun () -> eventId
        CommunityTimeZone = moscow
    }

let private run (moment: LocalDateTime) (deps: Deps) =
    execute
        deps
        {
            Id = Sample.meetupId
            Viewer = Sample.administrator
            Moment = moment
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private loading (snapshot: MeetupSnapshot option) (deps: Deps) =
    { deps with
        Load = fun _ -> Task.FromResult snapshot
    }

let private recording (written: ResizeArray<_>) (deps: Deps) =
    { deps with
        Commit =
            fun envelope state event ->
                written.Add(envelope, state, event)

                Meetup.apply state event
                |> Meetup.toSnapshot
                |> Ok
                |> Task.FromResult
    }

[<Fact>]
let ``A local moment becomes an instant in the community timezone`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> recording written
        |> run (localDateTime (DateOnly(2026, 10, 5)) 19 0)

    // 19:00 в Москве — 16:00 UTC; одно и то же мгновение лежит в состоянии, событии
    // и ответе команды.
    let at = DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)
    let envelope, _, event = written[0]

    test <@ written.Count = 1 @>
    test <@ envelope.OccurredAt = Sample.fixedNow @>
    test <@ event = MeetupPublicationScheduled at @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.ScheduledPublishAt) = Ok(Some at)
        @>

[<Fact>]
let ``A moment that already passed in the community timezone is refused`` () =
    // «Сейчас» фиксировано, а 19:00 предыдущего дня в Москве уже прошло: прошлое
    // решает пояс, а не сравнение локальной пары с локальными часами.
    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> run (localDateTime (DateOnly(2026, 9, 6)) 19 0)

    test <@ result = Error(ScheduleMeetupPublicationError.Domain PublicationMomentInThePast) @>

[<Fact>]
let ``A local time that does not exist is refused before the store is read`` () =
    // Ночь перехода на летнее время: 02:30 в Берлине не существует. Подставить
    // соседнее время значило бы назначить публикацию на момент, которого человек не
    // называл; хранилище для этого отказа не читается вовсе, и Load-заглушка,
    // падающая при вызове, доказывает это.
    let result =
        { stub with
            CommunityTimeZone = berlin
        }
        |> run (localDateTime (DateOnly(2026, 3, 29)) 2 30)

    let expected =
        ScheduleMeetupPublicationError.Malformed(
            Meetups.Slices.Contract.invalid "moment" "does not exist in the community timezone"
        )

    test <@ result = Error expected @>

[<Fact>]
let ``An ambiguous local time takes the standard offset`` () =
    // Обратный переход: 02:30 в Берлине существует дважды. Платформа разрешает
    // неоднозначность стандартным смещением (+01:00), и тест закрепляет это
    // поведение, чтобы его смена не прошла молча.
    let written = ResizeArray()

    let result =
        { stub with
            CommunityTimeZone = berlin
        }
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> recording written
        |> run (localDateTime (DateOnly(2026, 10, 25)) 2 30)

    let at = DateTimeOffset(2026, 10, 25, 1, 30, 0, TimeSpan.Zero)

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.ScheduledPublishAt) = Ok(Some at)
        @>

[<Fact>]
let ``Repeating the scheduled moment returns the snapshot without writing`` () =
    // 21:30 в Москве — это `later`, уже назначенный в образце: повтор той же кнопки
    // не пишет второй строки журнала.
    let stored = Meetup.toSnapshot Sample.scheduled

    let result =
        stub
        |> loading (Some stored)
        |> run (localDateTime (DateOnly(2026, 9, 8)) 21 30)

    test <@ result = Ok stored @>

[<Fact>]
let ``Scheduling an absent meetup is rejected without writing`` () =
    let result =
        stub
        |> loading None
        |> run (localDateTime (DateOnly(2026, 10, 5)) 19 0)

    test <@ result = Error(ScheduleMeetupPublicationError.Domain MeetupNotFound) @>

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

    let actual = run (localDateTime (DateOnly(2026, 10, 5)) 19 0) deps

    test <@ actual = Error ScheduleMeetupPublicationError.Conflict @>
