/// Коды отказов командных операций. Уровень выбран по достижимости: настоящий
/// конфликт версии случается только в гонке двух вызовов, а весь набор кодов
/// достижим подстановкой Deps — включая безопасный повтор, где основное чтение и
/// перечитывание после расхождения возвращают разные состояния.
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
open Meetups.TestRpc
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

module private Create =

    let deps load commit : CreateMeetupDraft.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

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
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.PublishMeetupRequest(Viewer = viewer, Id = meetupId, ExpectedVersion = Sample.expectedVersion)

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
        Create.deps (fun _ -> Task.FromResult(Some foreign)) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> CreateMeetupDraft.Api.handle deniedByOwner (Create.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A command on a missing meetup answers not found`` () =
    let missing =
        Publish.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

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
            (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.FailedPrecondition @>

/// ABORTED — реализационный выбор PER-56, контрактную строку закрепляет PER-78.
[<Fact>]
let ``A version conflict is refused as ABORTED`` () =
    let conflicting =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle conflicting (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Обязательность поля: без показанной версии решать не из чего, и отказ приходит
/// до хранилища — наблюдаемое доказательство тот же `untouched`, что и у отказа по
/// праву.
[<Fact>]
let ``A command without an expected version is refused as INVALID_ARGUMENT before the store`` () =
    let request =
        Meetups.V1.PublishMeetupRequest(Viewer = administrator (), Id = meetupId)

    test <@ codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched request) = Some StatusCode.InvalidArgument @>

/// Безопасный повтор: расхождение версий ещё не отказ, если цель команды уже в
/// силе. Повторное чтение возвращает уже видимую сходку — её снимок и уходит
/// ответом, хотя основное чтение видело скрытую и версия разошлась.
[<Fact>]
let ``A stale version with the target already in place is a safe retry`` () =
    let stored = Meetup.toSnapshot Sample.published

    let rechecking =
        let mutable first = true

        fun _ ->
            let snapshot = if first then Some(Meetup.toSnapshot Sample.titled) else Some stored

            first <- false
            Task.FromResult snapshot

    let deps =
        Publish.deps rechecking (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let answer =
        (PublishMeetup.Api.handle deps (Publish.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Version = stored.Version
            && answer.Visibility = Meetups.V1.MeetupVisibility.Visible
        @>

/// Критерий PER-195. Отдельным тестом, а не четвёртым элементом сторожа ниже: тот
/// требует попарно разные коды, а отказ по переходу делит FAILED_PRECONDITION с
/// отсутствующим заголовком намеренно — оба относятся к классу «запрос верен, домен
/// не позволяет». Различие с отказом по праву несёт код, различие с заголовком —
/// деталь статуса.
///
/// Тест идёт через настоящий Api.handle, а не через decidePublish: неполный match в
/// отображении остаётся предупреждением FS0025, сборка и гейт проходят зелёными, и
/// увидеть пропущенную ветку можно только здесь.
[<Fact>]
let ``A refused transition is told apart from a refused permission`` () =
    let cancelled =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let transition =
        codeOf (fun () -> PublishMeetup.Api.handle cancelled (Publish.request (administrator ())))

    let permission =
        codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched (Publish.request (ordinary ())))

    test
        <@
            transition = Some StatusCode.FailedPrecondition
            && permission = Some StatusCode.PermissionDenied
        @>

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
                (fun _ _ _ _ -> unreachable "Commit")

        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    let conflict =
        let conflicting =
            Publish.deps
                (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
                (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

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
            (fun _ _ _ _ -> Task.FromResult(Ok(Meetup.toSnapshot Sample.published)))

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
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.ChangeMeetupAttributesRequest(
            Viewer = viewer,
            Id = meetupId,
            ExpectedVersion = Sample.expectedVersion,
            Title = "F# after hours"
        )

module private Schedule =

    let deps load commit : SetMeetupSchedule.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e4"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = viewer,
            Id = meetupId,
            ExpectedVersion = Sample.expectedVersion,
            Schedule = Meetups.V1.Schedule(NoDate = Meetups.V1.NoDate())
        )

    /// Расписание, отличающееся от любого загруженного образца: расхождение версий
    /// на нём остаётся настоящим конфликтом, а не становится безопасным повтором.
    let changingRequest viewer =
        Meetups.V1.SetMeetupScheduleRequest(
            Viewer = viewer,
            Id = meetupId,
            ExpectedVersion = Sample.expectedVersion,
            Schedule =
                Meetups.V1.Schedule(
                    Fixed = Meetups.V1.DateValue(Day = Meetups.V1.CalendarDate(Year = 2026, Month = 10, Day = 3))
                )
        )

[<Fact>]
let ``Changing attributes is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle Change.untouched (Change.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Changing attributes of a missing meetup answers NOT_FOUND`` () =
    let missing =
        Change.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle missing (Change.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Обнаруженный при ревью дефект: конкурентная отмена не должна прятаться за
/// совпадением полей. Основное чтение видит сходку ещё не отменённой, а
/// перечитывание после расхождения версий — уже отменённой, но с теми же
/// атрибутами, что и в команде. Совпадение полей раньше маскировало это под
/// безопасный повтор; конкурентная отмена обязана остаться настоящим конфликтом.
[<Fact>]
let ``A concurrent cancellation while changing attributes is a real conflict, not a silent success`` () =
    let requestAttributes =
        {
            Title = "F# after hours"
            Description = ""
            Venue = ""
            Kind = ""
            CalendarLink = ""
        }

    let cancelledWithMatchingAttributes =
        let applied =
            Meetup.apply (Existing Sample.draft) (MeetupChanged(AttributesChanged requestAttributes))

        { Meetup.toSnapshot applied with
            Lifecycle = Cancelled
        }

    let rechecking =
        let mutable first = true

        fun _ ->
            let snapshot =
                if first then Some(Meetup.toSnapshot Sample.titled) else Some cancelledWithMatchingAttributes

            first <- false
            Task.FromResult snapshot

    let deps =
        Change.deps rechecking (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> ChangeMeetupAttributes.Api.handle deps (Change.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

[<Fact>]
let ``A version conflict while changing attributes is refused as ABORTED`` () =
    let conflicting =
        Change.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

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
        Schedule.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> SetMeetupSchedule.Api.handle missing (Schedule.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A version conflict while setting a schedule is refused as ABORTED`` () =
    let conflicting =
        Schedule.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> SetMeetupSchedule.Api.handle conflicting (Schedule.changingRequest (administrator ())))

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

/// Срезы переходов: снятие с публикации и отмена (PER-197), перевод в «состоялась»
/// (PER-229). Их отказы проверяются здесь, а не считаются такими же, как у
/// публикации: таблица кодов у каждого среза своя, и совпадение сегодня —
/// совпадение, а не абстракция. `TitleRequiredForPublication` в них недостижим и
/// объявлен нарушением внутреннего контракта, поэтому кода у него нет и здесь.
module private Unpublish =

    let deps load commit : UnpublishMeetup.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e5"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.UnpublishMeetupRequest(Viewer = viewer, Id = meetupId, ExpectedVersion = Sample.expectedVersion)

module private Cancel =

    let deps load commit : CancelMeetup.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e6"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.CancelMeetupRequest(Viewer = viewer, Id = meetupId, ExpectedVersion = Sample.expectedVersion)

module private Held =

    let deps load commit : MarkMeetupHeld.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e7"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.MarkMeetupHeldRequest(Viewer = viewer, Id = meetupId, ExpectedVersion = Sample.expectedVersion)

[<Fact>]
let ``Unpublishing is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> UnpublishMeetup.Api.handle Unpublish.untouched (Unpublish.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Unpublishing a missing meetup answers NOT_FOUND`` () =
    let missing =
        Unpublish.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> UnpublishMeetup.Api.handle missing (Unpublish.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Отмена закрывает снятие: отменённую видимую сходку прятать нельзя, иначе
/// извещение об отмене исчезало бы навсегда. Тест идёт через настоящий Api.handle,
/// а не через decideUnpublish: неполный match в отображении остаётся предупреждением
/// FS0025, и увидеть пропущенную ветку можно только здесь.
[<Fact>]
let ``Unpublishing a cancelled visible meetup is refused as FAILED_PRECONDITION`` () =
    let cancelled =
        Unpublish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelledVisible)))
            (fun _ _ _ _ -> unreachable "Commit")

    let transition =
        codeOf (fun () -> UnpublishMeetup.Api.handle cancelled (Unpublish.request (administrator ())))

    let permission =
        codeOf (fun () -> UnpublishMeetup.Api.handle Unpublish.untouched (Unpublish.request (ordinary ())))

    test
        <@
            transition = Some StatusCode.FailedPrecondition
            && permission = Some StatusCode.PermissionDenied
        @>

[<Fact>]
let ``A version conflict while unpublishing is refused as ABORTED`` () =
    let conflicting =
        Unpublish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> UnpublishMeetup.Api.handle conflicting (Unpublish.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Снятая сходка отвечает скрытой, но с сохранённой отметкой: именно эта пара
/// отличает возврат от первого показа, и наружу она видна только здесь.
[<Fact>]
let ``A successful unpublication answers with the hidden snapshot`` () =
    let hidden =
        Meetup.apply (Existing Sample.published) MeetupUnpublished
        |> Meetup.toSnapshot

    let deps =
        Unpublish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> Task.FromResult(Ok hidden))

    let answer =
        (UnpublishMeetup.Api.handle deps (Unpublish.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Visibility = Meetups.V1.MeetupVisibility.Hidden
            && answer.HasFirstPublishedAt
        @>

[<Fact>]
let ``Cancelling is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> CancelMeetup.Api.handle Cancel.untouched (Cancel.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Cancelling a missing meetup answers NOT_FOUND`` () =
    let missing =
        Cancel.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> CancelMeetup.Api.handle missing (Cancel.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Единственный отклонённый переход оси жизненного цикла: состоявшуюся сходку
/// отменять уже поздно.
[<Fact>]
let ``Cancelling a meetup that already took place is refused as FAILED_PRECONDITION`` () =
    let held =
        Cancel.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.held)))
            (fun _ _ _ _ -> unreachable "Commit")

    let transition =
        codeOf (fun () -> CancelMeetup.Api.handle held (Cancel.request (administrator ())))

    let permission =
        codeOf (fun () -> CancelMeetup.Api.handle Cancel.untouched (Cancel.request (ordinary ())))

    test
        <@
            transition = Some StatusCode.FailedPrecondition
            && permission = Some StatusCode.PermissionDenied
        @>

[<Fact>]
let ``A version conflict while cancelling is refused as ABORTED`` () =
    let conflicting =
        Cancel.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> CancelMeetup.Api.handle conflicting (Cancel.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Отменённая видимая сходка остаётся видимой и на границе: ось видимости отмена не
/// трогает, и именно так сообщество узнаёт об отмене.
[<Fact>]
let ``A successful cancellation answers with a visible cancelled snapshot`` () =
    let deps =
        Cancel.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> Task.FromResult(Ok(Meetup.toSnapshot Sample.cancelledVisible)))

    let answer =
        (CancelMeetup.Api.handle deps (Cancel.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Lifecycle = Meetups.V1.MeetupLifecycle.Cancelled
            && answer.Visibility = Meetups.V1.MeetupVisibility.Visible
        @>

/// Срезы материалов. Их отказы проверяются здесь по той же причине, что и у соседей:
/// таблица кодов у каждого среза своя, и совпадение сегодня — совпадение, а не
/// абстракция.
module private Attach =

    let deps load commit : AttachMaterial.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e7"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.AttachMaterialRequest(
            Viewer = viewer,
            Id = meetupId,
            MaterialId = "0199c0de-0000-7000-8000-0000000000a1",
            Title = "Афиша",
            Source = Meetups.V1.MeetupMaterialSource(MessageLink = "https://t.me/solguficky/42"),
            ExpectedVersion = Sample.expectedVersion
        )

module private Remove =

    let deps load commit : RemoveMaterial.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e8"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.RemoveMaterialRequest(
            Viewer = viewer,
            Id = meetupId,
            MaterialId = "0199c0de-0000-7000-8000-0000000000a1",
            ExpectedVersion = Sample.expectedVersion
        )

[<Fact>]
let ``Attaching a material is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> AttachMaterial.Api.handle Attach.untouched (Attach.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Marking as held is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> MarkMeetupHeld.Api.handle Held.untouched (Held.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Attaching a material to a missing meetup answers NOT_FOUND`` () =
    let missing =
        Attach.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> AttachMaterial.Api.handle missing (Attach.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Отмена закрывает прикрепление так же, как правку атрибутов: запрос собран верно,
/// но домен не позволяет переход.
[<Fact>]
let ``Attaching a material to a cancelled meetup answers FAILED_PRECONDITION`` () =
    let cancelled =
        Attach.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> AttachMaterial.Api.handle cancelled (Attach.request (administrator ())))

    test <@ actual = Some StatusCode.FailedPrecondition @>

[<Fact>]
let ``A version conflict while attaching a material is refused as ABORTED`` () =
    let conflicting =
        Attach.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> AttachMaterial.Api.handle conflicting (Attach.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Пустой oneof не является вторым написанием источника: у материала источник есть
/// всегда, и дочитать пустоту значением по умолчанию значило бы завести материал
/// без источника.
[<Fact>]
let ``Attaching a material without a source is refused as INVALID_ARGUMENT`` () =
    let request =
        Meetups.V1.AttachMaterialRequest(
            Viewer = administrator (),
            Id = meetupId,
            MaterialId = "0199c0de-0000-7000-8000-0000000000a1",
            Title = "Афиша"
        )

    test <@ codeOf (fun () -> AttachMaterial.Api.handle Attach.untouched request) = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``Attaching a material with an empty source is refused as INVALID_ARGUMENT`` () =
    let request =
        Meetups.V1.AttachMaterialRequest(
            Viewer = administrator (),
            Id = meetupId,
            MaterialId = "0199c0de-0000-7000-8000-0000000000a1",
            Title = "Афиша",
            Source = Meetups.V1.MeetupMaterialSource(FileId = "")
        )

    test <@ codeOf (fun () -> AttachMaterial.Api.handle Attach.untouched request) = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``Attaching a material with a non-canonical material id is refused as INVALID_ARGUMENT`` () =
    let request =
        Meetups.V1.AttachMaterialRequest(
            Viewer = administrator (),
            Id = meetupId,
            MaterialId = "0199c0de-0000-4000-8000-0000000000a1",
            Title = "Афиша",
            Source = Meetups.V1.MeetupMaterialSource(MessageLink = "https://t.me/solguficky/42")
        )

    test <@ codeOf (fun () -> AttachMaterial.Api.handle Attach.untouched request) = Some StatusCode.InvalidArgument @>

/// Материал виден на проводе целиком: идентификатор, название и вид источника.
/// Позиция и авторство привязки наружу не выходят — их в контракте нет.
[<Fact>]
let ``A successful attachment answers with the material in the snapshot`` () =
    let attached =
        Meetup.apply (Existing Sample.titled) (MeetupMaterialAttached Sample.material)
        |> Meetup.toSnapshot

    let deps =
        Attach.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Ok attached))

    let answer =
        (AttachMaterial.Api.handle deps (Attach.request (administrator ()))).GetAwaiter().GetResult()

    let material = Seq.exactlyOne answer.Materials

    test
        <@
            material.Id = "0199c0de-0000-7000-8000-0000000000a1"
            && material.Title = Sample.material.Title
            && material.Source.SourceCase = Meetups.V1.MeetupMaterialSource.SourceOneofCase.MessageLink
        @>

[<Fact>]
let ``Removing a material is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> RemoveMaterial.Api.handle Remove.untouched (Remove.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Removing a material from a missing meetup answers NOT_FOUND`` () =
    let missing =
        Remove.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> RemoveMaterial.Api.handle missing (Remove.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``Removing a material from a cancelled meetup answers FAILED_PRECONDITION`` () =
    let cancelled =
        Remove.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelledWithMaterial)))
            (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> RemoveMaterial.Api.handle cancelled (Remove.request (administrator ())))

    test <@ actual = Some StatusCode.FailedPrecondition @>

[<Fact>]
let ``A version conflict while removing a material is refused as ABORTED`` () =
    let conflicting =
        Remove.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.withMaterial)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> RemoveMaterial.Api.handle conflicting (Remove.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Повтор удаления — достигнутое целевое состояние: ответ успешен и не несёт
/// материала, потому что его в снимке уже нет.
[<Fact>]
let ``A repeated removal answers with the snapshot without the material`` () =
    let deps =
        Remove.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let answer =
        (RemoveMaterial.Api.handle deps (Remove.request (administrator ()))).GetAwaiter().GetResult()

    test <@ Seq.isEmpty answer.Materials @>

[<Fact>]
let ``Marking a missing meetup as held answers NOT_FOUND`` () =
    let missing =
        Held.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> MarkMeetupHeld.Api.handle missing (Held.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// Единственный отклонённый переход этого среза: отмена необратима.
[<Fact>]
let ``Marking a cancelled meetup as held is refused as FAILED_PRECONDITION`` () =
    let cancelled =
        Held.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let transition =
        codeOf (fun () -> MarkMeetupHeld.Api.handle cancelled (Held.request (administrator ())))

    let permission =
        codeOf (fun () -> MarkMeetupHeld.Api.handle Held.untouched (Held.request (ordinary ())))

    test
        <@
            transition = Some StatusCode.FailedPrecondition
            && permission = Some StatusCode.PermissionDenied
        @>

[<Fact>]
let ``A version conflict while marking as held is refused as ABORTED`` () =
    let conflicting =
        Held.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> MarkMeetupHeld.Api.handle conflicting (Held.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Отметка не трогает видимость: состоявшаяся видимая сходка остаётся видимой и на
/// границе.
[<Fact>]
let ``A successful held transition answers with a visible held snapshot`` () =
    let heldVisible =
        Meetup.apply (Existing Sample.published) MeetupHeld
        |> Meetup.toSnapshot

    let deps =
        Held.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> Task.FromResult(Ok heldVisible))

    let answer =
        (MarkMeetupHeld.Api.handle deps (Held.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Lifecycle = Meetups.V1.MeetupLifecycle.Held
            && answer.Visibility = Meetups.V1.MeetupVisibility.Visible
        @>

module private SchedulePublication =

    let private at year month day hours minutes =
        Meetups.V1.LocalDateTime(
            Date = Meetups.V1.CalendarDate(Year = year, Month = month, Day = day),
            Time = Meetups.V1.LocalTime(Hours = hours, Minutes = minutes)
        )

    let deps load commit : ScheduleMeetupPublication.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e7"
            // Пояс проверяется отдельно, в тестах среза; на границе достаточно
            // фиксированного, чтобы значение доходило до домена.
            CommunityTimeZone = TimeZoneInfo.Utc
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.ScheduleMeetupPublicationRequest(
            Viewer = viewer,
            Id = meetupId,
            Moment = at 2026 10 5 16 0,
            ExpectedVersion = Sample.expectedVersion
        )

    /// Момент заведомо раньше фиксированного «сейчас»: 16:00 предыдущего дня.
    let requestPast viewer =
        Meetups.V1.ScheduleMeetupPublicationRequest(
            Viewer = viewer,
            Id = meetupId,
            Moment = at 2026 9 6 16 0,
            ExpectedVersion = Sample.expectedVersion
        )

module private CancelPublication =

    let deps load commit : CancelMeetupPublication.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e8"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ _ -> unreachable "Commit")

    let request viewer =
        Meetups.V1.CancelMeetupPublicationRequest(
            Viewer = viewer,
            Id = meetupId,
            ExpectedVersion = Sample.expectedVersion
        )

[<Fact>]
let ``Scheduling a publication is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () ->
            ScheduleMeetupPublication.Api.handle
                SchedulePublication.untouched
                (SchedulePublication.request (ordinary ()))
        )

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Scheduling a publication on a missing meetup answers NOT_FOUND`` () =
    let missing =
        SchedulePublication.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> ScheduleMeetupPublication.Api.handle missing (SchedulePublication.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

[<Fact>]
let ``A request without a moment is refused as INVALID_ARGUMENT before the store`` () =
    let request =
        Meetups.V1.ScheduleMeetupPublicationRequest(Viewer = administrator (), Id = meetupId)

    let actual =
        codeOf (fun () -> ScheduleMeetupPublication.Api.handle SchedulePublication.untouched request)

    test <@ actual = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``A past moment and a published meetup are refused with different codes`` () =
    let past =
        SchedulePublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let published =
        SchedulePublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.published)))
            (fun _ _ _ _ -> unreachable "Commit")

    let pastCode =
        codeOf (fun () ->
            ScheduleMeetupPublication.Api.handle past (SchedulePublication.requestPast (administrator ()))
        )

    let publishedCode =
        codeOf (fun () ->
            ScheduleMeetupPublication.Api.handle published (SchedulePublication.request (administrator ()))
        )

    // Значение запроса недопустимо — INVALID_ARGUMENT; состояние сходки не
    // позволяет — FAILED_PRECONDITION. Различие объявлено в integration.md.
    test <@ pastCode = Some StatusCode.InvalidArgument @>
    test <@ publishedCode = Some StatusCode.FailedPrecondition @>

[<Fact>]
let ``Scheduling a publication on a cancelled meetup is refused as FAILED_PRECONDITION`` () =
    let cancelled =
        SchedulePublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () ->
            ScheduleMeetupPublication.Api.handle cancelled (SchedulePublication.request (administrator ()))
        )

    test <@ actual = Some StatusCode.FailedPrecondition @>

[<Fact>]
let ``A version conflict while scheduling a publication is refused as ABORTED`` () =
    let conflicting =
        SchedulePublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () ->
            ScheduleMeetupPublication.Api.handle conflicting (SchedulePublication.request (administrator ()))
        )

    test <@ actual = Some StatusCode.Aborted @>

[<Fact>]
let ``A successful scheduling answers with the moment as RFC 3339 UTC`` () =
    let scheduled =
        Meetup.apply (Existing Sample.titled) (MeetupPublicationScheduled Sample.later)
        |> Meetup.toSnapshot

    let deps =
        SchedulePublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> Task.FromResult(Ok scheduled))

    let answer =
        (ScheduleMeetupPublication.Api.handle deps (SchedulePublication.request (administrator ())))
            .GetAwaiter()
            .GetResult()

    test
        <@
            answer.HasScheduledPublishAt
            && answer.ScheduledPublishAt.EndsWith "Z"
        @>

    test <@ DateTimeOffset.Parse answer.ScheduledPublishAt = Sample.later @>

[<Fact>]
let ``Cancelling a scheduled publication is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () ->
            CancelMeetupPublication.Api.handle CancelPublication.untouched (CancelPublication.request (ordinary ()))
        )

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Cancelling a scheduled publication on a missing meetup answers NOT_FOUND`` () =
    let missing =
        CancelPublication.deps (fun _ -> Task.FromResult None) (fun _ _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> CancelMeetupPublication.Api.handle missing (CancelPublication.request (administrator ())))

    test <@ actual = Some StatusCode.NotFound @>

/// У сходки без момента отменять нечего: команда целевая, и повтор не пишет строки
/// журнала — Commit здесь падает при любом вызове.
[<Fact>]
let ``Cancelling an unscheduled meetup answers the snapshot without writing`` () =
    let deps =
        CancelPublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ _ -> unreachable "Commit")

    let answer =
        (CancelMeetupPublication.Api.handle deps (CancelPublication.request (administrator ())))
            .GetAwaiter()
            .GetResult()

    test
        <@
            answer.Id = meetupId
            && not answer.HasScheduledPublishAt
        @>

[<Fact>]
let ``A version conflict while cancelling a publication is refused as ABORTED`` () =
    let conflicting =
        CancelPublication.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.scheduled)))
            (fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> CancelMeetupPublication.Api.handle conflicting (CancelPublication.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>
