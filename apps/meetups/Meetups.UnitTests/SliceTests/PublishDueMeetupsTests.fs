/// Решение одного тика отложенной публикации: что уходит в запись, что пропускается
/// молча, где пачка продолжается вопреки отказу и что тик рассказывает о себе.
///
/// Базы здесь нет намеренно: всё, что проверяется ниже, решает код, а не PostgreSQL.
/// Сама атомарность перехода — свойство предиката записи, и её проверяет
/// интеграционный сценарий, потому что ответить на неё может только настоящая база.
module Meetups.SliceTests.PublishDueMeetupsTests

open System
open System.Threading
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.PublishDueMeetups
open Meetups.TestData
open Swensen.Unquote
open Xunit

/// Зависимость, которую тест не переопределил, обязана падать с внятным сообщением, а
/// не возвращать молчаливый успех: иначе тест на «запись не позвана» проходил бы и на
/// реализации, которая её позвала.
let private notReached (name: string) : 'a = failwith $"{name} must not be reached in this test"

let private now = DateTimeOffset(2026, 9, 7, 18, 30, 0, TimeSpan.Zero)

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"

/// Идентификаторы различаются только хвостом: в падении сразу видно, на какой сходке
/// пачка разошлась с ожиданием.
let private meetupId (n: int) = MeetupId(Guid.Parse("0199c0de-0000-7000-8001-" + n.ToString "D12"))

/// Сходка с наступившим моментом: образец `scheduled` скрыт, имеет заголовок и несёт
/// момент в будущем относительно `Sample.fixedNow`. Тик смотрит на момент только
/// выборкой, поэтому «наступил» здесь выражает сам факт попадания снимка в набор.
let private due (n: int) =
    { Meetup.toSnapshot Sample.scheduled with
        Id = meetupId n
    }

let private visible (n: int) =
    { Meetup.toSnapshot Sample.published with
        Id = meetupId n
    }

/// Черновик без заголовка, которому момент всё-таки назначен: назначение смотрит на
/// видимость и жизненный цикл, а полноту атрибутов не проверяет.
let private untitledSnapshot =
    Meetup.apply (Existing Sample.draft) (MeetupPublicationScheduled Sample.later)
    |> Meetup.toSnapshot

let private untitled (n: int) =
    { untitledSnapshot with
        Id = meetupId n
    }

let private backlog (count: int64) (oldest: DateTimeOffset option) =
    {
        Due = count
        OldestDueAt = oldest
    }

let private deps =
    {
        ReadDue = fun _ _ -> notReached "ReadDue"
        Commit = fun _ _ _ _ -> notReached "Commit"
        Now = fun () -> now
        NewEventId = fun () -> eventId
        NewRequestId = fun () -> (RequestId.create "due-fixed").Value
        BatchSize = 10
    }

/// Набор, который отдаёт выборка, вместе со счётчиком её вызовов.
let private reading (snapshots: MeetupSnapshot list) =
    { deps with
        ReadDue = fun _ _ -> task { return backlog (int64 (List.length snapshots)) None, snapshots }
    }

/// Запись, которая всегда успешна, вместе с журналом своих аргументов: «что доехало
/// до хранилища» — утверждение о поведении, и проверять его нужно наблюдением.
let private recordingCommit () =
    let calls = ResizeArray<MeetupStore.EventEnvelope * int64 option * MeetupEvent>()

    let commit envelope expectedVersion state event =
        task {
            calls.Add(envelope, expectedVersion, event)

            return Ok(Meetup.apply state event |> Meetup.toSnapshot)
        }

    commit, calls

let private run (deps: Deps) (token: CancellationToken) =
    execute deps token
    |> Async.AwaitTask
    |> Async.RunSynchronously

[<Fact>]
let ``A due meetup is published`` () =
    let commit, calls = recordingCommit ()

    let report =
        run
            { reading [ due 1 ] with
                Commit = commit
            }
            CancellationToken.None

    test <@ report.Published = 1 @>

    test
        <@
            report.Claimed = 0
            && report.Blocked = []
            && report.Failed = []
        @>

    test <@ calls.Count = 1 @>

/// Событие то же, что у ручной публикации, и это требование ADR-024: отложенность —
/// свойство момента подачи команды, а не отдельный вид публикации.
[<Fact>]
let ``Publishing a due meetup records the same event a manual publication records`` () =
    let commit, calls = recordingCommit ()

    run
        { reading [ due 1 ] with
            Commit = commit
        }
        CancellationToken.None
    |> ignore

    let _, _, event = calls[0]

    test <@ event = MeetupPublished now @>

/// Ожидаемая версия — та, что пришла со снимком выборки. На ней и держится
/// однократность: второй претендент на ту же строку не пройдёт предикат записи.
[<Fact>]
let ``The expected version comes from the scanned snapshot`` () =
    let commit, calls = recordingCommit ()
    let snapshot = due 1

    run
        { reading [ snapshot ] with
            Commit = commit
        }
        CancellationToken.None
    |> ignore

    let _, expectedVersion, _ = calls[0]

    test <@ expectedVersion = Some snapshot.Version @>

/// Человека у этого сценария нет, и журнал не должен утверждать обратное.
[<Fact>]
let ``The event is performed by the clock, not by a person`` () =
    let commit, calls = recordingCommit ()

    run
        { reading [ due 1 ] with
            Commit = commit
        }
        CancellationToken.None
    |> ignore

    let envelope, _, _ = calls[0]

    test <@ envelope.PerformedBy = clockPerformer @>
    test <@ envelope.PerformedBy = PersonId Guid.Empty @>
    test <@ envelope.OccurredAt = now @>

/// Видимая сходка в набор попасть не может: выборка отбирает строки предикатом
/// `visibility = 'hidden'`, а схема держит его CHECK-ограничением. Если она всё же
/// дошла до решения, сломан контракт между выборкой и срезом, и тик говорит об этом
/// отказом, а не тихим пропуском.
///
/// Пачку такой отказ не роняет: он изолирован строкой и доезжает до отчёта — иначе
/// остановка, убранная для доменных отказов, вернулась бы через исключение.
[<Fact>]
let ``A visible meetup in the set breaks the contract and fails its own row only`` () =
    let commit, calls = recordingCommit ()

    let report =
        run
            { reading [ visible 1; due 2 ] with
                Commit = commit
            }
            CancellationToken.None

    test <@ List.map fst report.Failed = [ meetupId 1 ] @>
    test <@ report.Published = 1 @>
    test <@ calls.Count = 1 @>

/// Расхождение версий — проигранная гонка, а не отказ сервиса: строку изменил кто-то
/// другой, и следующий тик увидит её актуальной.
[<Fact>]
let ``A version conflict is counted as a lost race`` () =
    let report =
        run
            { reading [ due 1 ] with
                Commit = fun _ _ _ _ -> task { return Error MeetupStore.VersionConflict }
            }
            CancellationToken.None

    test <@ report.Claimed = 1 @>
    test <@ report.Published = 0 && report.Failed = [] @>

/// Черновик без заголовка остаётся в наборе, и это единственный исход, о котором тик
/// говорит громко: сам он не рассосётся.
[<Fact>]
let ``A meetup the domain refuses is reported with its reason`` () =
    let report = run (reading [ untitled 1 ]) CancellationToken.None

    test
        <@
            report.Blocked = [
                meetupId 1, TitleRequiredForPublication
            ]
        @>

    test <@ report.Published = 0 @>

/// Ключевое отличие от публикации из журнала: там первый отказ останавливает пачку
/// ради порядка версий, здесь сходки независимы, и одна незаполненная не смеет
/// держать остальные.
[<Fact>]
let ``One refused meetup does not stop the rest of the batch`` () =
    let commit, calls = recordingCommit ()

    let report =
        run
            { reading [ untitled 1; due 2; due 3 ] with
                Commit = commit
            }
            CancellationToken.None

    test <@ report.Published = 2 @>

    test
        <@
            report.Blocked = [
                meetupId 1, TitleRequiredForPublication
            ]
        @>

    test <@ calls.Count = 2 @>

/// Оборванная запись на одной сходке не уносит отчёт тика: до этой правки исключение
/// выходило из `execute`, и вместе с ним терялись уже записанные публикации пачки.
[<Fact>]
let ``A throwing commit fails its own row and leaves the rest of the batch alone`` () =
    let commit, calls = recordingCommit ()

    let failing envelope expectedVersion state event =
        if state = Meetup.restore (Some(due 1)) then
            failwith "the connection was closed"
        else
            commit envelope expectedVersion state event

    let report =
        run
            { reading [ due 1; due 2 ] with
                Commit = failing
            }
            CancellationToken.None

    test <@ List.map fst report.Failed = [ meetupId 1 ] @>
    test <@ report.Published = 1 @>
    test <@ calls.Count = 1 @>

/// Отмена наблюдаема в отчёте: иначе укороченный остановкой тик выглядел бы как тик,
/// которому было нечего делать.
[<Fact>]
let ``A cancelled tick stops the batch and says so`` () =
    use cancellation = new CancellationTokenSource()
    cancellation.Cancel()

    let report = run (reading [ due 1; due 2 ]) cancellation.Token

    test <@ report.Cancelled @>
    test <@ report.Published = 0 @>

/// Возраст считается от назначенного момента тем же мгновением, из которого принято
/// решение: это просрочка публикации, а не возраст строки.
[<Fact>]
let ``The age of the oldest due moment is measured from the tick's own clock`` () =
    let oldest = now.AddMinutes -7.0

    let report =
        run
            { deps with
                ReadDue = fun _ _ -> task { return backlog 3L (Some oldest), [] }
            }
            CancellationToken.None

    test <@ report.OldestDueAge = Some(TimeSpan.FromMinutes 7.0) @>
    test <@ report.Backlog.Due = 3L @>

/// Пустой набор не имеет возраста, и поле остаётся пустым, а не нулевым: ноль здесь
/// означал бы «момент наступил только что».
[<Fact>]
let ``An empty set has no age`` () =
    let report =
        run
            { deps with
                ReadDue = fun _ _ -> task { return backlog 0L None, [] }
            }
            CancellationToken.None

    test <@ report.OldestDueAge = None @>
    test <@ report.Backlog.Due = 0L @>

/// Часы читаются один раз на тик: выборка и решение обязаны говорить об одном
/// мгновении, иначе размер набора и опубликованное описывают разные наборы.
[<Fact>]
let ``The scan receives the same moment the decision is taken from`` () =
    let observed = ResizeArray<DateTimeOffset>()

    run
        { deps with
            ReadDue =
                fun scanAt _ ->
                    task {
                        observed.Add scanAt
                        return backlog 0L None, []
                    }
        }
        CancellationToken.None
    |> ignore

    test <@ List.ofSeq observed = [ now ] @>

module ConfigurationTests =

    open Microsoft.Extensions.Configuration

    let private configuration (pairs: (string * string) list) =
        ConfigurationBuilder()
            .AddInMemoryCollection(
                pairs
                |> List.map (fun (key, value) -> Collections.Generic.KeyValuePair(key, value))
            )
            .Build()
        :> IConfiguration

    let private empty = ConfigurationBuilder().Build() :> IConfiguration

    /// Тридцать секунд, а не две: допустимая задержка здесь — единицы минут, и
    /// опрашивать таблицу сходок чаще незачем.
    [<Fact>]
    let ``The interval falls back to thirty seconds`` () =
        test <@ Composition.interval empty = TimeSpan.FromSeconds 30.0 @>

    [<Fact>]
    let ``The interval is read from the environment`` () =
        let value =
            configuration [ Composition.IntervalVariable, "90" ]
            |> Composition.interval

        test <@ value = TimeSpan.FromSeconds 90.0 @>

    /// Опечатка в конфигурации остаётся наблюдаемой как редкий тик, а не как молчащий
    /// сервис.
    [<Fact>]
    let ``An interval beyond the ceiling is clamped to an hour`` () =
        let value =
            configuration
                [
                    Composition.IntervalVariable, "100000"
                ]
            |> Composition.interval

        test <@ value = TimeSpan.FromSeconds 3600.0 @>

    [<Theory>]
    [<InlineData "0">]
    [<InlineData "-5">]
    [<InlineData "half a minute">]
    let ``A value that is not a positive number falls back`` (raw: string) =
        let value =
            configuration [ Composition.IntervalVariable, raw ]
            |> Composition.interval

        test <@ value = TimeSpan.FromSeconds 30.0 @>

    [<Fact>]
    let ``The batch size falls back and is clamped`` () =
        test <@ Composition.batchSize empty = 100 @>

        let clamped =
            configuration
                [
                    Composition.BatchSizeVariable, "50000"
                ]
            |> Composition.batchSize

        test <@ clamped = 1000 @>

/// Выдаёт `due-1`, `due-2`, … по порядку вызовов: по номеру видно, какой сходке какой
/// id достался.
let private sequentialRequestIds () =
    let issued = ref 0

    fun () ->
        issued.Value <- issued.Value + 1
        (RequestId.create $"due-{issued.Value}").Value

/// PER-227: у повода по расписанию собственный id, по одному на сходку, и он уходит в
/// конверт события — рядом с событием в журнале.
[<Fact>]
let ``Every published meetup starts a chain of its own`` () =
    let commit, calls = recordingCommit ()

    run
        { reading [ due 1; due 2 ] with
            Commit = commit
            NewRequestId = sequentialRequestIds ()
        }
        CancellationToken.None
    |> ignore

    let written =
        calls
        |> Seq.map (fun (envelope, _, _) -> envelope.RequestId |> Option.map RequestId.value)
        |> List.ofSeq

    test <@ written = [ Some "due-1"; Some "due-2" ] @>
