/// Состав записи фоновой границы отложенной публикации. Каркас из
/// docs/standards/observability/logging.md проверяется по именам полей, а не по
/// отформатированному тексту, и без хоста: то, что поля обязаны быть именно такими, —
/// требование норматива, а не свойство цикла.
///
/// Здесь же закрывается критерий приёмки «по логам видно, что воркер жив и набор не
/// растёт»: живость несёт сама запись тика, размер набора — поле `due`, застревание —
/// `oldest_due_age_us` рядом с ним.
module Meetups.DuePublicationLogTests

open System
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.TestData
open Meetups.Slices.PublishDueMeetups
open Meetups.Transport
open Microsoft.Extensions.Logging
open Swensen.Unquote
open Xunit

let private duration = 1234L

let private meetupId = MeetupId(Guid.Parse "0199c0de-0000-7000-8001-000000000001")

let private report =
    {
        Backlog =
            {
                Due = 0L
                OldestDueAt = None
            }
        OldestDueAge = None
        Published = 0
        Claimed = 0
        Blocked = []
        Failed = []
        Cancelled = false
    }

let private described (value: TickReport) =
    let level, fields = DuePublicationLog.describe value duration

    level,
    fields
    |> List.map (fun (name, raw) -> name, string raw)
    |> Map.ofList

[<Fact>]
let ``A tick that published carries the frame of an operation`` () =
    let level, fields =
        described
            { report with
                Backlog =
                    {
                        Due = 1L
                        OldestDueAt = None
                    }
                Published = 1
            }

    test <@ level = LogLevel.Information @>
    test <@ fields.TryFind "service" = Some "meetups" @>
    test <@ fields.TryFind "operation" = Some "meetups.publication.due" @>
    test <@ fields.TryFind "result" = Some "ok" @>
    test <@ fields.TryFind "duration_us" = Some "1234" @>
    test <@ fields.TryFind "published" = Some "1" @>

/// Периодическая фоновая работа — операция без сценария, и `request_id` у тика
/// рождаться неоткуда: цепочки, через которую его проносят, здесь нет.
[<Fact>]
let ``A tick carries neither a use case nor a request id`` () =
    let _, fields = described report

    test <@ fields.TryFind "use_case" = None @>
    test <@ fields.TryFind "request_id" = None @>

/// Тик, которому было нечего делать, остаётся на Debug: на горячем цикле
/// Information означал бы запись каждые полминуты ни о чём.
[<Fact>]
let ``An empty tick stays at debug`` () =
    let level, fields = described report

    test <@ level = LogLevel.Debug @>
    test <@ fields.TryFind "result" = Some "ok" @>

/// Набор пишется всегда, даже нулевой: это и есть ответ на «набор не растёт», а поле,
/// появляющееся только при ненулевом значении, превратило бы вопрос «сколько ждёт» в
/// вопрос по наличию поля.
[<Fact>]
let ``The size of the set is written on every tick`` () =
    let _, empty = described report

    let _, filled =
        described
            { report with
                Backlog =
                    {
                        Due = 4L
                        OldestDueAt = None
                    }
            }

    test <@ empty.TryFind "due" = Some "0" @>
    test <@ filled.TryFind "due" = Some "4" @>

/// Просрочка пишется микросекундами, как и длительность: единицу времени записи
/// держит логирование, а не метрики.
[<Fact>]
let ``The age of the oldest due moment is written in microseconds`` () =
    let _, fields =
        described
            { report with
                OldestDueAge = Some(TimeSpan.FromSeconds 2.0)
            }

    test <@ fields.TryFind "oldest_due_age_us" = Some "2000000" @>

[<Fact>]
let ``An empty set omits the age instead of writing a zero`` () =
    let _, fields = described report

    test <@ fields.TryFind "oldest_due_age_us" = None @>

/// Поле, присутствующее с нулём в каждой записи, превращает запрос «были ли
/// проигранные гонки» в запрос по значению.
[<Fact>]
let ``Lost races are written only when they happened`` () =
    let _, quiet = described report

    let _, raced =
        described
            { report with
                Claimed = 2
            }

    test <@ quiet.TryFind "claimed" = None @>
    test <@ raced.TryFind "claimed" = Some "2" @>

/// Неожиданный отказ на одной сходке — Error, а не Warning, и он перебивает
/// отклонённый переход: сломанный путь срочнее сходки, которая ждёт человека.
[<Fact>]
let ``A failed meetup outranks a refused one and is an error`` () =
    let level, fields =
        described
            { report with
                Blocked =
                    [
                        meetupId, TitleRequiredForPublication
                    ]
                Failed =
                    [
                        meetupId, "the connection was closed"
                    ]
            }

    test <@ level = LogLevel.Error @>
    test <@ fields.TryFind "error_category" = Some "unexpected" @>
    test <@ fields.TryFind "error" = Some "the connection was closed" @>
    test <@ fields.TryFind "failed" = Some "1" @>
    test <@ fields.TryFind "blocked" = Some "1" @>

/// Отклонённый доменом переход сам не рассосётся: сходка остаётся в наборе, пока
/// человек не поправит её. Warning и никакого stack — норматив держит stack для
/// неожиданного отказа, а этот ожидаемый.
[<Fact>]
let ``A refused transition is a warning that names the meetup and the reason`` () =
    let level, fields =
        described
            { report with
                Blocked =
                    [
                        meetupId, TitleRequiredForPublication
                    ]
            }

    test <@ level = LogLevel.Warning @>
    test <@ fields.TryFind "result" = Some "error" @>
    test <@ fields.TryFind "error_category" = Some "invariant" @>
    test <@ fields.TryFind "error" = Some "TitleRequiredForPublication" @>
    test <@ fields.TryFind "meetup_id" = Some "0199c0de-0000-7000-8001-000000000001" @>
    test <@ fields.TryFind "blocked" = Some "1" @>
    test <@ fields.TryFind "stack" = None @>

/// Неожиданный отказ — единственный, который несёт stack.
[<Fact>]
let ``An unexpected failure carries its stack`` () =
    let fields =
        DuePublicationLog.unexpected (InvalidOperationException "the database is gone") duration
        |> List.map (fun (name, raw) -> name, string raw)
        |> Map.ofList

    test <@ fields.TryFind "result" = Some "error" @>
    test <@ fields.TryFind "error_category" = Some "unexpected" @>
    test <@ fields.TryFind "error" = Some "the database is gone" @>
    test <@ fields.ContainsKey "stack" @>

[<Fact>]
let ``A cancelled tick says so`` () =
    let _, fields =
        described
            { report with
                Cancelled = true
            }

    test <@ fields.TryFind "cancelled" = Some "True" @>

/// Критерий PER-227 «у сработавшего по расписанию повода есть собственный
/// идентификатор»: запись о начатой цепочке несёт его и называет сходку.
[<Fact>]
let ``A chain started by the tick carries its own request id`` () =
    let requestId = (RequestId.create "due-1").Value

    let fields =
        DuePublicationLog.started duration (meetupId, requestId)
        |> List.map (fun (name, raw) -> name, string raw)
        |> Map.ofList

    let (MeetupId id) = meetupId

    test <@ fields.TryFind "request_id" = Some "due-1" @>
    test <@ fields.TryFind "meetup_id" = Some(string id) @>
    test <@ fields.TryFind "operation" = Some DuePublicationLog.Operation @>
    test <@ fields.TryFind "result" = Some "ok" @>

/// Сам тик цепочкой не является: он начинает по одной на сходку, и id пишут их
/// записи, а не запись тика.
[<Fact>]
let ``The tick record itself carries no request id`` () =
    let _, fields =
        described
            { report with
                Published = 1
            }

    test <@ fields.ContainsKey "request_id" = false @>

let private envelope (requestId: string) : MeetupStore.EventEnvelope =
    {
        EventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"
        PerformedBy = PersonId Guid.Empty
        OccurredAt = DateTimeOffset(2026, 9, 7, 18, 30, 0, TimeSpan.Zero)
        RequestId = RequestId.create requestId
    }

/// Запись, обёрнутая границей, вместе с записями лога, которые она оставила.
let private announced (answer: Result<MeetupSnapshot, MeetupStore.VersionConflict>) =
    let written = ResizeArray<(string * obj) list>()

    let commit =
        DuePublicationLog.announcing written.Add (fun _ _ _ _ -> Task.FromResult answer)

    commit (envelope "due-1") (Some 1L) Initial (MeetupPublished Sample.later)
    |> Async.AwaitTask
    |> Async.RunSynchronously
    |> ignore

    List.ofSeq written

/// Запись пишется в момент коммита, а не из отчёта тика: отмена посреди пачки
/// уносит отчёт, а уже опубликованная сходка без записи не нашлась бы в логах.
[<Fact>]
let ``A committed publication is recorded the moment it is committed`` () =
    let snapshot = Meetup.toSnapshot Sample.scheduled

    let written = announced (Ok snapshot)

    let (MeetupId id) = snapshot.Id

    test
        <@
            written
            |> List.map Map.ofList
            |> List.map (fun fields ->
                fields.TryFind "request_id" |> Option.map string, fields.TryFind "meetup_id" |> Option.map string
            ) = [ Some "due-1", Some(string id) ]
        @>

/// Проигранная гонка события не породила, и цепочка не началась.
[<Fact>]
let ``A lost race starts no chain`` () = test <@ announced (Error MeetupStore.VersionConflict) = [] @>
