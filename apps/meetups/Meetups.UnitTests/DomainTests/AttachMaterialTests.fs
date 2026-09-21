module Meetups.DomainTests.AttachMaterialTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private attach (state: MeetupState) =
    Meetup.decideAttachMaterial Sample.authorId Sample.otherMaterialId "Афиша" (FileId "file-1") state

[<Fact>]
let ``When a material is attached expect an event with the first position`` () =
    let expected =
        MeetupMaterialAttached
            {
                Id = Sample.otherMaterialId
                Position = 1
                Title = "Афиша"
                Source = FileId "file-1"
                BoundBy = Sample.authorId
            }

    test <@ attach (Existing Sample.titled) = Ok(Some expected) @>

/// Место в порядке назначает решение, а не применение: следующий материал встаёт
/// после последнего. Вставку в середину выразит отдельная команда порядка (RFC-004),
/// в этот срез не входящая.
[<Fact>]
let ``When the collection already has a material expect the next position`` () =
    let position =
        match attach (Existing Sample.withMaterial) with
        | Ok(Some(MeetupMaterialAttached material)) -> material.Position
        | other -> failwith $"expected an attach event, got {other}"

    test <@ position = 2 @>

/// Название тотально, как и информационные атрибуты сходки: пустая строка — это
/// «не указано», и отдельного отказа у неё нет.
[<Fact>]
let ``When the title is empty expect the material is still attached`` () =
    let decision =
        Meetup.decideAttachMaterial
            Sample.authorId
            Sample.otherMaterialId
            ""
            (MessageLink "https://t.me/solguficky/42")
            (Existing Sample.titled)

    test <@ decision |> Result.map Option.isSome = Ok true @>

/// Идентификатор материала — ключ идемпотентности, как `id` у создания черновика:
/// повтор не плодит второй материал и события не даёт.
[<Fact>]
let ``When the same material id is attached again expect no event`` () =
    let repeat =
        Meetup.decideAttachMaterial
            Sample.authorId
            Sample.materialId
            "Афиша"
            (FileId "file-1")
            (Existing Sample.withMaterial)

    test <@ repeat = Ok None @>

/// Повтор идёт первым: уже прикреплённый материал — достигнутое целевое состояние,
/// и отмена сходки его не отменяет, как не отменяет уже видимой публикации.
[<Fact>]
let ``When the material is already attached to a cancelled meetup expect no event`` () =
    let repeat =
        Meetup.decideAttachMaterial
            Sample.authorId
            Sample.materialId
            "Другое название"
            (FileId "file-2")
            (Existing Sample.cancelledWithMaterial)

    test <@ repeat = Ok None @>

/// Отмена закрывает прикрепление так же, как закрывает правку атрибутов (PER-197):
/// материалы — обычное редактирование сведений о сходке.
[<Fact>]
let ``When the meetup is cancelled expect the attachment is refused`` () =
    test <@ attach (Existing Sample.cancelled) = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup does not exist expect the attachment is refused`` () =
    test <@ attach Initial = Error MeetupNotFound @>

/// Видимость правку не запрещает: у опубликованной сходки материал прикрепляется
/// так же, как у черновика (ADR-031, пересмотр 2026-09-21).
[<Fact>]
let ``When the meetup is published expect the attachment is allowed`` () =
    test
        <@
            attach (Existing Sample.published)
            |> Result.map Option.isSome = Ok true
        @>
