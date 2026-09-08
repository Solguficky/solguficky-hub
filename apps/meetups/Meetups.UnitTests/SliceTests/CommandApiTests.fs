/// Коды отказов командных операций. Уровень выбран по достижимости: через
/// настоящий gRPC не воспроизвести конфликт версии — `expected_version` во вход
/// команд не входит намеренно (ADR-031), поэтому снаружи он наблюдается только как
/// гонка двух параллельных вызовов. Здесь весь набор достижим подстановкой Deps.
///
/// Тест идёт настоящим путём `Api.handle` и ловит RpcException, а не заглядывает в
/// приватное отображение: проверяется то, что увидит клиент.
module Meetups.SliceTests.CommandApiTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private meetupId = "0199c0de-0000-7000-8000-0000000000f1"

let private viewerWith (roles: Identity.V1.GlobalRole seq) =
    let viewer = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")
    viewer.GlobalRoles.AddRange roles
    viewer

let private administrator () = viewerWith [ Identity.V1.GlobalRole.Admin ]
let private ordinary () = viewerWith []

/// Отказ, а не молчание: заглушка, возвращающая пустоту, оставила бы пропущенную
/// проверку прав зелёным тестом.
let private unreachable name : 'a = failwith $"{name} must not be reached"

/// GetAwaiter().GetResult(), а не Async.RunSynchronously: второй заворачивает отказ
/// в AggregateException, и объявленный RpcException перестал бы ловиться по типу.
let private codeOf (call: unit -> Task<'a>) =
    try
        call().GetAwaiter().GetResult() |> ignore
        None
    with :? RpcException as declined ->
        Some declined.StatusCode

module private Create =

    let deps load commit : CreateMeetupDraft.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer = Meetups.V1.CreateMeetupDraftRequest(Viewer = viewer, Id = meetupId)

module private Publish =

    let deps load commit : PublishMeetup.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e2"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer = Meetups.V1.PublishMeetupRequest(Viewer = viewer, Id = meetupId)

[<Fact>]
let ``A request without a viewer is refused as INVALID_ARGUMENT before the store`` () =
    let request = Meetups.V1.CreateMeetupDraftRequest(Id = meetupId)

    test
        <@ codeOf (fun () -> CreateMeetupDraft.Api.handle Create.untouched request) = Some StatusCode.InvalidArgument @>

/// Заголовочный критерий задачи, и Deps здесь падают на любом обращении: зелёный
/// тест доказывает не только код, но и то, что до хранилища вызов не дошёл.
[<Fact>]
let ``An ordinary viewer is refused as PERMISSION_DENIED before the store`` () =
    let actual =
        codeOf (fun () -> CreateMeetupDraft.Api.handle Create.untouched (Create.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Publishing is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched (Publish.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

/// Чужой черновик отвечает «не найдено»: ответ не подтверждает, что он существует
/// (ADR-022, ADR-031).
///
/// Сравнить с той же операцией на несуществующей сходке нельзя: CreateMeetupDraft на
/// свободном id по построению успешен, а не «не найден». Поэтому утверждение здесь
/// про код, а не про пару вызовов, и неотличимость держится тем, что код совпадает с
/// кодом соседней операции ниже, а не тем, что две ветки одной операции сошлись.
[<Fact>]
let ``A draft of another author answers not found`` () =
    let foreign =
        Meetup.apply Initial (MeetupCreated(Sample.meetupId, Sample.otherAuthorId))
        |> Meetup.toSnapshot

    let deniedByOwner =
        Create.deps (fun _ -> Task.FromResult(Some foreign)) (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> CreateMeetupDraft.Api.handle deniedByOwner (Create.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A command on a missing meetup answers not found`` () =
    let missing =
        Publish.deps (fun _ -> Task.FromResult None) (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle missing (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Запрос собран верно, но домен не позволяет переход: FAILED_PRECONDITION, а не
/// INVALID_ARGUMENT. Разделение принято в integration.md.
[<Fact>]
let ``Publishing without a title is refused as FAILED_PRECONDITION`` () =
    let titleless =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.FailedPrecondition @>

/// ABORTED — реализационный выбор PER-56, контрактную строку закрепляет PER-78.
[<Fact>]
let ``A version conflict is refused as ABORTED`` () =
    let conflicting =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle conflicting (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Сам критерий приёмки, а не три литерала: отсутствие права, нарушенный инвариант
/// и конфликт версии обязаны различаться кодом.
[<Fact>]
let ``Permission, invariant and version conflict are told apart by code`` () =
    let forbidden =
        codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched (Publish.request (ordinary ())))

    let invariant =
        let titleless =
            Publish.deps
                (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
                (fun _ _ _ -> unreachable "Commit")

        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    let conflict =
        let conflicting =
            Publish.deps
                (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
                (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

        codeOf (fun () -> PublishMeetup.Api.handle conflicting (Publish.request (administrator ())))

    let codes = [ forbidden; invariant; conflict ]

    test
        <@
            List.distinct codes = codes
            && List.forall Option.isSome codes
        @>

[<Fact>]
let ``A successful publication answers with the rendered snapshot`` () =
    let deps =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ -> Task.FromResult(Ok(Meetup.toSnapshot Sample.published)))

    let answer =
        (PublishMeetup.Api.handle deps (Publish.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Id = meetupId
            && answer.Visibility = Meetups.V1.MeetupVisibility.Visible
            && answer.HasFirstPublishedAt
        @>

/// Два оставшихся среза. Норматив тестирования требует наблюдаемого отображения на
/// следующей границе для каждого case ожидаемого error DU, поэтому их отказы
/// проверяются здесь, а не считаются такими же, как у соседа: таблица кодов у
/// каждого среза своя, и совпадение сегодня — совпадение, а не абстракция.
module private Change =

    let deps load commit : ChangeMeetupAttributes.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e3"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.ChangeMeetupAttributesRequest(Viewer = viewer, Id = meetupId, Title = "F# after hours")

module private Schedule =

    let deps load commit : SetMeetupSchedule.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e4"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = viewer,
            Id = meetupId,
            Schedule = Meetups.V1.Schedule(NoDate = Meetups.V1.NoDate())
        )

[<Fact>]
let ``Changing attributes is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle Change.untouched (Change.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Changing attributes of a missing meetup answers NOT_FOUND`` () =
    let missing =
        Change.deps (fun _ -> Task.FromResult None) (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle missing (Change.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A version conflict while changing attributes is refused as ABORTED`` () =
    let conflicting =
        Change.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle conflicting (Change.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

[<Fact>]
let ``Setting a schedule is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> SetMeetupSchedule.Api.handle Schedule.untouched (Schedule.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Setting a schedule on a missing meetup answers NOT_FOUND`` () =
    let missing =
        Schedule.deps (fun _ -> Task.FromResult None) (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> SetMeetupSchedule.Api.handle missing (Schedule.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A version conflict while setting a schedule is refused as ABORTED`` () =
    let conflicting =
        Schedule.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> SetMeetupSchedule.Api.handle conflicting (Schedule.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Расписание — единственный вход, у которого свой разбор внутри среза, поэтому его
/// отказы наблюдаются отдельно от общих полей запроса.
[<Fact>]
let ``An inverted interval is refused as INVALID_ARGUMENT`` () =
    let at hours minutes =
        Meetups.V1.LocalDateTime(
            Date = Meetups.V1.CalendarDate(Year = 2026, Month = 10, Day = 3),
            Time = Meetups.V1.LocalTime(Hours = hours, Minutes = minutes)
        )

    let request =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = administrator (),
            Id = meetupId,
            Schedule =
                Meetups.V1.Schedule(
                    Fixed = Meetups.V1.DateValue(Interval = Meetups.V1.LocalInterval(Start = at 21 0, End = at 18 30))
                )
        )

    test
        <@ codeOf (fun () -> SetMeetupSchedule.Api.handle Schedule.untouched request) = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``An out of range time is refused as INVALID_ARGUMENT`` () =
    let request =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = administrator (),
            Id = meetupId,
            Schedule =
                Meetups.V1.Schedule(
                    Tentative =
                        Meetups.V1.DateValue(
                            DayStart =
                                Meetups.V1.LocalDateTime(
                                    Date = Meetups.V1.CalendarDate(Year = 2026, Month = 10, Day = 3),
                                    Time = Meetups.V1.LocalTime(Hours = 24, Minutes = 0)
                                )
                        )
                )
        )

    test
        <@ codeOf (fun () -> SetMeetupSchedule.Api.handle Schedule.untouched request) = Some StatusCode.InvalidArgument @>

/// Год 0 месяц 0 день 0 — то, что приходит из незаполненного CalendarDate: DateOnly
/// на нём бросает, и без перехвата это стало бы UNKNOWN вместо INVALID_ARGUMENT.
[<Fact>]
let ``An impossible calendar date is refused as INVALID_ARGUMENT`` () =
    let request =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = administrator (),
            Id = meetupId,
            Schedule = Meetups.V1.Schedule(Fixed = Meetups.V1.DateValue(Day = Meetups.V1.CalendarDate()))
        )

    test
        <@ codeOf (fun () -> SetMeetupSchedule.Api.handle Schedule.untouched request) = Some StatusCode.InvalidArgument @>
