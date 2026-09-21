module Meetups.DomainTests.RemoveMaterialTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the material is attached expect a removal event`` () =
    let decision =
        Meetup.decideRemoveMaterial Sample.materialId (Existing Sample.withMaterial)

    test <@ decision = Ok(Some(MeetupMaterialRemoved Sample.materialId)) @>

/// Команда сформулирована как целевое состояние: отсутствие материала — успех без
/// события, и повтор после потерянного ответа безопасен.
[<Fact>]
let ``When the material is absent expect no event`` () =
    test <@ Meetup.decideRemoveMaterial Sample.otherMaterialId (Existing Sample.withMaterial) = Ok None @>

[<Fact>]
let ``When the meetup is cancelled expect the removal is refused`` () =
    let decision =
        Meetup.decideRemoveMaterial Sample.materialId (Existing Sample.cancelledWithMaterial)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup does not exist expect the removal is refused`` () =
    test <@ Meetup.decideRemoveMaterial Sample.materialId Initial = Error MeetupNotFound @>

/// Удаление середины коллекции не двигает соседей: их позиции остаются теми же, и
/// остальная коллекция от удаления не меняется.
[<Fact>]
let ``Removing one material leaves the others in place`` () =
    let second =
        {
            Id = Sample.otherMaterialId
            Position = 2
            Title = "Вторая афиша"
            Source = FileId "file-2"
            BoundBy = Sample.authorId
        }

    let two =
        Meetup.apply (Existing Sample.withMaterial) (MeetupMaterialAttached second)

    let removed =
        Meetup.apply (Existing two) (MeetupMaterialRemoved Sample.materialId)
        |> Meetup.toSnapshot

    test <@ removed.Materials = [ second ] @>
    test <@ removed.Version = (Meetup.toSnapshot two).Version + 1L @>

/// Применение удаления не трогает ни оси состояния, ни отметку публикации: материал
/// не является ни осью, ни признаком того, что сходка была показана.
[<Fact>]
let ``Removing a material leaves the axes and the publication mark untouched`` () =
    let published =
        Meetup.apply (Existing Sample.published) (MeetupMaterialAttached Sample.material)

    let removed =
        Meetup.apply (Existing published) (MeetupMaterialRemoved Sample.materialId)
        |> Meetup.toSnapshot

    let axes = removed.Visibility, removed.Lifecycle, removed.FirstPublishedAt

    test <@ axes = (Visible, Planned, Some Sample.fixedNow) @>
