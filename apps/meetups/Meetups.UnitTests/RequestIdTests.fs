/// Инвариант сквозного id (PER-227): граница принимает ровно то, что примет колонка
/// журнала, и отбрасывает остальное как «значения нет», а не роняет команду.
module Meetups.RequestIdTests

open System
open Meetups
open Swensen.Unquote
open Xunit

[<Fact>]
let ``A request id is kept as it came`` () =
    test
        <@
            RequestId.create "req-1"
            |> Option.map RequestId.value = Some "req-1"
        @>

[<Fact>]
let ``A blank header is no request id`` () =
    test <@ RequestId.create "" = None @>
    test <@ RequestId.create "   " = None @>
    test <@ RequestId.create null = None @>

/// Предел совпадает с CHECK колонки: значение на границе проходит, на единицу длиннее
/// — нет, иначе запись в журнал упала бы на ограничении схемы посреди команды.
[<Fact>]
let ``A request id is at most the length the journal accepts`` () =
    let atLimit = String('r', RequestId.MaxLength)
    let overLimit = String('r', RequestId.MaxLength + 1)

    test
        <@
            RequestId.create atLimit
            |> Option.map RequestId.value = Some atLimit
        @>

    test <@ RequestId.create overLimit = None @>

[<Fact>]
let ``A fresh request id is distinct every time`` () =
    test
        <@
            RequestId.value (RequestId.fresh ())
            <> RequestId.value (RequestId.fresh ())
        @>
