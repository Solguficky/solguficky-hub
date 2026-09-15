module Meetups.DomainTests.SetMeetupScheduleTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the schedule is set expect a single MeetupChanged event carrying it`` () =
    // У расписания нет своего типа события: повод тот же, что у смены атрибутов.
    let decision = Meetup.decideSetSchedule (Fixed Sample.day) (Existing Sample.titled)

    test <@ decision = Ok(MeetupChanged(ScheduleChanged(Fixed Sample.day))) @>

[<Fact>]
let ``When the meetup does not exist expect the schedule change is refused`` () =
    let decision = Meetup.decideSetSchedule (Fixed Sample.day) Initial

    test <@ decision = Error MeetupNotFound @>

[<Fact>]
let ``When the schedule is applied expect the informational attributes untouched`` () =
    let before = Meetup.toSnapshot Sample.titled

    let after =
        Meetup.apply (Existing Sample.titled) (MeetupChanged(ScheduleChanged(Tentative Sample.day)))
        |> Meetup.toSnapshot

    test <@ (after.Schedule, after.Title, after.Venue) = (Tentative Sample.day, before.Title, before.Venue) @>

[<Fact>]
let ``When the schedule repeats the current value expect a MeetupChanged event all the same`` () =
    let scheduled =
        Meetup.apply (Existing Sample.titled) (MeetupChanged(ScheduleChanged(Fixed Sample.day)))

    let decision = Meetup.decideSetSchedule (Fixed Sample.day) (Existing scheduled)

    test <@ decision = Ok(MeetupChanged(ScheduleChanged(Fixed Sample.day))) @>

[<Fact>]
let ``When the schedule is cleared to no date expect the change to be accepted`` () =
    // «Даты нет» — форма расписания, а не отсутствие значения и не отказ.
    let scheduled =
        Meetup.apply (Existing Sample.titled) (MeetupChanged(ScheduleChanged(Fixed Sample.day)))

    let cleared =
        Meetup.apply (Existing scheduled) (MeetupChanged(ScheduleChanged NoDate))
        |> Meetup.toSnapshot

    test <@ cleared.Schedule = NoDate @>
