/// Разбор запроса и отрисовка снимка — единственное место, где сгенерированный
/// контракт встречается с доменом. Проверяется здесь, потому что дальше по границе
/// эти же случаи стоили бы поднятого хоста.
module Meetups.SliceTests.ContractTests

open System
open Meetups.Domain
open Meetups.Slices
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private canonical = "0199c0de-0000-7000-8000-0000000000f1"

let private viewerWith (roles: Identity.V1.GlobalRole seq) =
    let viewer = Meetups.V1.Viewer(IdentityId = canonical)
    viewer.GlobalRoles.AddRange roles
    viewer

let private problem (result: Result<'a, Contract.InvalidRequest>) =
    match result with
    | Ok _ -> None
    | Error invalid -> Some invalid.Field

[<Fact>]
let ``Meetup id should be accepted in canonical form`` () =
    test <@ Contract.Inbound.meetupId canonical = Ok(MeetupId(Guid.Parse canonical)) @>

/// Канонический вид требует нижнего регистра, а TryParseExact "D" принимает и
/// верхний: без сравнения со своей формой запись прошла бы.
[<Fact>]
let ``Meetup id should be refused in upper case`` () =
    test <@ problem (Contract.Inbound.meetupId (canonical.ToUpperInvariant())) = Some "id" @>

[<Fact>]
let ``Meetup id should be refused without hyphens`` () =
    test <@ problem (Contract.Inbound.meetupId (canonical.Replace("-", ""))) = Some "id" @>

/// Домен обещает, что версию UUID проверяет граница (Domain/Ids.fs). Здесь это
/// обещание и исполняется.
[<Fact>]
let ``Meetup id should be refused when the UUID version is not seven`` () =
    test <@ problem (Contract.Inbound.meetupId "0199c0de-0000-4000-8000-0000000000f1") = Some "id" @>

[<Fact>]
let ``Meetup id should be refused when it is empty`` () = test <@ problem (Contract.Inbound.meetupId "") = Some "id" @>

[<Fact>]
let ``Viewer should be refused when the message is absent`` () =
    test <@ problem (Contract.Inbound.viewer null) = Some "viewer" @>

[<Fact>]
let ``Viewer should be refused when the identity is not a canonical UUIDv7`` () =
    test <@ problem (Contract.Inbound.viewer (Meetups.V1.Viewer())) = Some "viewer.identity_id" @>

[<Fact>]
let ``Viewer without roles should be an ordinary user`` () =
    let expected =
        {
            IdentityId = PersonId(Guid.Parse canonical)
            Roles = Set.empty
        }

    test <@ Contract.Inbound.viewer (viewerWith []) = Ok expected @>

[<Fact>]
let ``Viewer with the admin role should carry it into the domain`` () =
    let parsed = Contract.Inbound.viewer (viewerWith [ Identity.V1.GlobalRole.Admin ])

    test
        <@
            parsed
            |> Result.map (fun viewer -> Viewer.isAdministrator viewer) = Ok true
        @>

/// Схема объявляет UNSPECIFIED значением «роль неизвестна потребителю», поэтому
/// неизвестное значение отбрасывается, а не отвергается: отказ превратил бы
/// добавление роли в Identity в отказ обслуживания у Meetups.
[<Fact>]
let ``Unknown role should be dropped instead of refusing the request`` () =
    let roles =
        [
            Identity.V1.GlobalRole.Unspecified
            enum<Identity.V1.GlobalRole> 99
            Identity.V1.GlobalRole.Admin
        ]

    let parsed = Contract.Inbound.viewer (viewerWith roles)

    test <@ parsed |> Result.map (fun viewer -> viewer.Roles) = Ok(Set.singleton Administrator) @>

[<Fact>]
let ``Unknown role alone should not grant anything`` () =
    let parsed =
        Contract.Inbound.viewer (viewerWith [ enum<Identity.V1.GlobalRole> 99 ])

    test <@ parsed |> Result.map (fun viewer -> viewer.Roles) = Ok Set.empty @>

[<Fact>]
let ``Snapshot of a draft should leave the first publication mark unset`` () =
    let contract = Contract.Outbound.snapshot (Meetup.toSnapshot Sample.draft)

    test <@ not contract.HasFirstPublishedAt @>

/// Контракт требует RFC 3339 UTC: формат "o" у DateTimeOffset печатает смещение
/// +00:00, поэтому отметка снимается с UtcDateTime.
[<Fact>]
let ``Snapshot of a published meetup should carry the mark as RFC 3339 UTC`` () =
    let contract = Contract.Outbound.snapshot (Meetup.toSnapshot Sample.published)

    test
        <@
            contract.HasFirstPublishedAt
            && contract.FirstPublishedAt.EndsWith "Z"
        @>

    test <@ DateTimeOffset.Parse contract.FirstPublishedAt = Sample.fixedNow @>

[<Fact>]
let ``Snapshot should render identifiers in the same canonical form the border demands`` () =
    let contract = Contract.Outbound.snapshot (Meetup.toSnapshot Sample.published)

    test
        <@
            Contract.Inbound.meetupId contract.Id = Ok Sample.meetupId
            && Contract.Inbound.viewer (Meetups.V1.Viewer(IdentityId = contract.Author))
               |> Result.map (fun viewer -> viewer.IdentityId) = Ok Sample.authorId
        @>

[<Fact>]
let ``Snapshot should render both state axes and the version`` () =
    let contract = Contract.Outbound.snapshot (Meetup.toSnapshot Sample.published)

    test
        <@
            contract.Lifecycle = Meetups.V1.MeetupLifecycle.Planned
            && contract.Visibility = Meetups.V1.MeetupVisibility.Visible
            && contract.Version = 3L
        @>

/// «Даты нет» — форма no_date, а не пустой oneof: контракт вторым написанием этого
/// не читает, и отрисовка обязана ставить форму явно.
[<Fact>]
let ``Absent date should be rendered as the no_date form`` () =
    let contract = Contract.Outbound.schedule NoDate

    test <@ contract.FormCase = Meetups.V1.Schedule.FormOneofCase.NoDate @>

[<Fact>]
let ``Tentative day should keep its form and precision`` () =
    let contract = Contract.Outbound.schedule (Tentative Sample.day)

    test
        <@
            contract.FormCase = Meetups.V1.Schedule.FormOneofCase.Tentative
            && contract.Tentative.PrecisionCase = Meetups.V1.DateValue.PrecisionOneofCase.Day
            && contract.Tentative.Day.Year = 2026
            && contract.Tentative.Day.Month = 10
            && contract.Tentative.Day.Day = 3
        @>

[<Fact>]
let ``Fixed interval should keep both bounds with minute precision`` () =
    let start =
        {
            Date = DateOnly(2026, 10, 3)
            Time = TimeOnly(18, 30)
        }

    let finish =
        {
            Date = DateOnly(2026, 10, 3)
            Time = TimeOnly(21, 0)
        }

    let interval =
        LocalInterval.create start finish
        |> Result.defaultWith (fun _ -> failwith "the sample interval must be valid")

    let contract = Contract.Outbound.schedule (Fixed(Interval interval))

    test
        <@
            contract.Fixed.Interval.Start.Time.Hours = 18
            && contract.Fixed.Interval.Start.Time.Minutes = 30
            && contract.Fixed.Interval.End.Time.Hours = 21
            && contract.Fixed.Interval.End.Time.Minutes = 0
        @>
