module Meetups.DomainTests.MeetupApplyTests

open System
open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private identity meetup =
    let snapshot = Meetup.toSnapshot meetup
    snapshot.Id, snapshot.Author

let private version meetup = (Meetup.toSnapshot meetup).Version

[<Fact>]
let ``Apply should raise the version by exactly one for a change`` () =
    test <@ version Sample.titled = version Sample.draft + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a publication`` () =
    test <@ version Sample.published = version Sample.titled + 1L @>

[<Fact>]
let ``Apply should keep the identifier and the author for every event`` () =
    let hidden = Meetup.apply (Existing Sample.published) MeetupUnpublished
    let returned = Meetup.apply (Existing hidden) MeetupRepublished
    let cancelled = Meetup.apply (Existing Sample.published) MeetupCancelled

    let identities =
        [
            identity Sample.draft
            identity Sample.titled
            identity Sample.published
            identity hidden
            identity returned
            identity cancelled
        ]
        |> List.distinct

    test <@ identities = [ Sample.meetupId, Sample.authorId ] @>

[<Fact>]
let ``Apply should raise the version by exactly one for a visibility change`` () =
    let hidden = Meetup.apply (Existing Sample.published) MeetupUnpublished
    let returned = Meetup.apply (Existing hidden) MeetupRepublished

    test <@ version hidden = version Sample.published + 1L @>
    test <@ version returned = version hidden + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a cancellation`` () =
    let cancelled = Meetup.apply (Existing Sample.published) MeetupCancelled

    test <@ version cancelled = version Sample.published + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a material`` () =
    let attached =
        Meetup.apply (Existing Sample.titled) (MeetupMaterialAttached Sample.material)

    let removed =
        Meetup.apply (Existing attached) (MeetupMaterialRemoved Sample.materialId)

    test <@ version attached = version Sample.titled + 1L @>
    test <@ version removed = version attached + 1L @>

/// Материал входит в состояние применением события, а не командой записи: событие
/// несёт и позицию, и авторство привязки, поэтому собранный снаружи материал
/// состоянием не становится.
[<Fact>]
let ``Apply should take the material from the event as it is`` () =
    let attached =
        Meetup.apply (Existing Sample.titled) (MeetupMaterialAttached Sample.material)
        |> Meetup.toSnapshot

    test <@ attached.Materials = [ Sample.material ] @>

[<Fact>]
let ``Apply should raise the version by exactly one for a held transition`` () =
    let held = Meetup.apply (Existing Sample.titled) MeetupHeld

    test <@ version held = version Sample.titled + 1L @>
    test <@ (Meetup.toSnapshot held).Lifecycle = Held @>

[<Fact>]
let ``Apply should raise the version by exactly one for the publication moment`` () =
    let scheduled =
        Meetup.apply (Existing Sample.titled) (MeetupPublicationScheduled Sample.later)

    let unscheduled = Meetup.apply (Existing scheduled) MeetupPublicationCancelled

    test <@ version scheduled = version Sample.titled + 1L @>
    test <@ version unscheduled = version scheduled + 1L @>

[<Fact>]
let ``Apply should store the scheduled publication moment in the state`` () =
    test <@ (Meetup.toSnapshot Sample.titled).ScheduledPublishAt = None @>
    test <@ (Meetup.toSnapshot Sample.scheduled).ScheduledPublishAt = Some Sample.later @>

[<Fact>]
let ``Apply should consume the scheduled publication moment on publication`` () =
    // Момент забирает себе публикация: назначенное время наступило, и оставленное
    // поле противоречило бы схеме и снимку. Раньше это обнуление стояло в SQL
    // (PER-280), теперь оно принадлежит состоянию.
    let published =
        Meetup.apply (Existing Sample.scheduled) (MeetupPublished Sample.fixedNow)

    test <@ (Meetup.toSnapshot published).ScheduledPublishAt = None @>
    test <@ (Meetup.toSnapshot published).FirstPublishedAt = Some Sample.fixedNow @>

[<Fact>]
let ``Apply should clear the scheduled publication moment on cancellation`` () =
    // Иначе отменённая сходка осталась бы с назначенной публикацией, а критерий
    // PER-204 требует обратного.
    let cancelled = Meetup.apply (Existing Sample.scheduled) MeetupCancelled

    test <@ (Meetup.toSnapshot cancelled).ScheduledPublishAt = None @>
    test <@ (Meetup.toSnapshot cancelled).Lifecycle = Cancelled @>

[<Fact>]
let ``Apply should leave the lifecycle planned`` () =
    // Оси независимы: публикация двигает видимость и жизненного цикла не касается.
    // Переходы обеих конечных стадий дают свои команды, и их собственный эффект
    // проверяют CancelMeetupTests и MarkMeetupHeldTests.
    test <@ (Meetup.toSnapshot Sample.published).Lifecycle = Planned @>

[<Fact>]
let ``Apply should reject an event decided from another state`` () =
    // Такую пару не возвращает ни одно решение: она означает дефект оболочки, а не
    // отклонённый переход домена, поэтому исключение, а не DomainError.
    let change = MeetupChanged(AttributesChanged Sample.attributes)
    let creation = MeetupCreated(Sample.meetupId, Sample.authorId)

    raises<InvalidOperationException> <@ Meetup.apply Initial change @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupUnpublished @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupRepublished @>
    raises<InvalidOperationException> <@ Meetup.apply Initial (MeetupPublicationScheduled Sample.later) @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupPublicationCancelled @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupCancelled @>
    raises<InvalidOperationException> <@ Meetup.apply Initial (MeetupMaterialAttached Sample.material) @>
    raises<InvalidOperationException> <@ Meetup.apply Initial (MeetupMaterialRemoved Sample.materialId) @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupHeld @>
    raises<InvalidOperationException> <@ Meetup.apply (Existing Sample.draft) creation @>
