/// Таблицы переходов обеих осей. Уровень минимальный честный: таблица — чистая
/// функция от значений одной оси, и её граница это она сама. Агрегат, снимок и
/// образцы здесь не нужны, и это следствие выбранной формы, а не удача.
///
/// Ожидание записано литеральным списком, а не вторым вызовом таблицы: сверять
/// таблицу с самой собой значило бы получить тест, зелёный при любой её ошибке.
module Meetups.DomainTests.MeetupTransitionsTests

open FSharp.Reflection
open Swensen.Unquote
open Xunit
open Meetups.Domain

let private lifecycleCells =
    [
        (Planned, Planned), TransitionOutcome.AlreadyThere
        (Planned, Held), TransitionOutcome.Allowed
        (Planned, Cancelled), TransitionOutcome.Allowed
        (Held, Planned), TransitionOutcome.Rejected
        (Held, Held), TransitionOutcome.AlreadyThere
        (Held, Cancelled), TransitionOutcome.Rejected
        (Cancelled, Planned), TransitionOutcome.Rejected
        (Cancelled, Held), TransitionOutcome.Rejected
        (Cancelled, Cancelled), TransitionOutcome.AlreadyThere
    ]

let private visibilityCells =
    [
        (Hidden, Hidden), TransitionOutcome.AlreadyThere
        (Hidden, Visible), TransitionOutcome.Allowed
        (Visible, Hidden), TransitionOutcome.Allowed
        (Visible, Visible), TransitionOutcome.AlreadyThere
    ]

/// Значения оси берутся у самого типа, а не переписываются в тест руками: иначе
/// сторож полноты ниже проверял бы список против его же копии.
let private axisValues<'axis> () =
    FSharpType.GetUnionCases typeof<'axis>
    |> Array.map (fun case -> FSharpValue.MakeUnion(case, [||]) :?> 'axis)
    |> List.ofArray

[<Fact>]
let ``The lifecycle table should answer every pair of its axis as written`` () =
    let actual =
        lifecycleCells
        |> List.map (fun ((current, target), _) -> MeetupTransitions.lifecycle current target)

    test <@ actual = List.map snd lifecycleCells @>

[<Fact>]
let ``The visibility table should answer every pair of its axis as written`` () =
    let actual =
        visibilityCells
        |> List.map (fun ((current, target), _) -> MeetupTransitions.visibility current target)

    test <@ actual = List.map snd visibilityCells @>

/// Сторожа полноты списков ниже закрывают узкую щель, и стоит назвать её точно,
/// чтобы от них не ждали большего. Сама таблица полна по построению: её match
/// перечисляет пары без catch-all, поэтому новое значение оси сначала уронит
/// сборку продукта. Но чинят сборку в продуктовом файле, а списки здесь остались бы
/// прежними, и новые клетки тихо оказались бы непроверенными — вот это и краснеет.
///
/// Чего сторожа не ловят: новую ось со своей таблицей, у которой списка тут нет
/// вовсе; расширение TransitionOutcome; значение оси с полями — на нём axisValues
/// упадёт исключением, а не внятным утверждением.
let private allPairsOf<'axis> () =
    let values = axisValues<'axis> ()
    List.allPairs values values

/// Множество ловит пропущенную и лишнюю пару, длина — повтор одной и той же клетки:
/// он сошёлся бы по множеству и оставил другую клетку непроверенной.
[<Fact>]
let ``The tested lifecycle pairs should be every pair the axis can form`` () =
    let possible = allPairsOf<MeetupLifecycle> ()

    test
        <@
            set (List.map fst lifecycleCells) = set possible
            && List.length lifecycleCells = List.length possible
        @>

[<Fact>]
let ``The tested visibility pairs should be every pair the axis can form`` () =
    let possible = allPairsOf<MeetupVisibility> ()

    test
        <@
            set (List.map fst visibilityCells) = set possible
            && List.length visibilityCells = List.length possible
        @>
