# Standard: тестирование F#-кода

> **Статус:** Active  
> **Применимость:** автоматические тесты F#-компонентов  
> **Связанные документы:** [testing-strategy.md](testing-strategy.md), [languages/fsharp.md](../languages/fsharp.md), [architecture/functional-slices.md](../architecture/functional-slices.md), service-local README и nested `AGENTS.md`

Норматив уточняет общую стратегию тестирования для F# и фиксирует согласованный инструментарий без переноса тестов на более дорогой уровень.

Примеры написаны на нейтральном домене и показывают форму теста, а не состав тестового набора конкретного сервиса. Они собраны и прогнаны на .NET 10 с xUnit v3, Unquote, FsCheck и Moq.

## Инструменты

- xUnit v3 — test framework и runner для F#-проектов.
- Unquote — основной синтаксис утверждений над F#-значениями.
- FsCheck — property-based проверки инвариантов, переходов и round-trip отображений, когда пространство входов важнее набора примеров.
- Testcontainers for .NET — реальная инфраструктура интеграционного теста, если boundary нельзя честно проверить in-process.
- Moq допускается для .NET-интерфейса на императивной границе. Сначала предпочитай чистую функцию, record of functions или маленький handwritten fake: mock взаимодействий не заменяет проверку наблюдаемого результата.
- FsUnit не добавляется рядом с Unquote без отдельной причины: два assertion DSL в одном новом компоненте не дают дополнительного свойства.

Версии закрепляются существующим способом репозитория при создании проекта; standard не содержит быстро устаревающих номеров пакетов.

Две детали интеграции проверены и не выводятся из документации пакетов:

- FsCheck подключается к xUnit v3 пакетом `FsCheck.Xunit.v3`. Пакет `FsCheck.Xunit` рассчитан на xUnit v2 и здесь не подходит.
- Функции `Gen` и `Arb` в FsCheck 3 живут в `FsCheck.FSharp`. Без `open FsCheck.FSharp` собственный generator не собирается: одного `open FsCheck` недостаточно.

xUnit v3 сам порождает entry point тестового проекта. Рукописный `Program.fs` в тестовом проекте не заводится: он конфликтует со сгенерированным.

## Утверждения

Unquote печатает разобранное выражение вместе с фактическими значениями, поэтому утверждение пишется целиком внутри цитаты, а не разбивается на подготовительные проверки.

```fsharp
open Swensen.Unquote

[<Fact>]
let ``payment of a new order yields OrderPaid`` () =
    let order = { sampleOrder with Status = New }

    let result = Order.decidePayment fixedNow order

    test <@ result = Ok (OrderPaid fixedNow) @>

[<Fact>]
let ``payment of a paid order is rejected`` () =
    let order = { sampleOrder with Status = Paid earlier }

    let result = Order.decidePayment fixedNow order

    test <@ result = Error OrderAlreadyPaid @>
```

Имя теста — обратные кавычки с предложением на английском, описывающим проверяемое свойство. Одна форма имени на файл; смешивать `When … expect …` и декларативный инвариант в одном наборе не нужно.

## Что проверять

- Доменный decision, применение результата к состоянию, отклонённые переходы и идемпотентный повтор проверяются чистыми unit-тестами.
- Каждый case ожидаемого error DU имеет наблюдаемое отображение на следующей границе. Неожиданный exception проверяется отдельно и не маскируется доменным отказом.
- Boundary mapping покрывает `null`, отсутствующие поля, неизвестный enum/case, неверный primitive и успешный round trip там, где обратимость обещана.

```fsharp
[<Fact>]
let ``unknown enum value is rejected instead of defaulting`` () =
    let message = PlaceOrderRequest (OrderId = validId, Kind = enum<OrderKind> 99)

    let result = Mapping.fromProto message

    test <@ result = Error (UnknownEnumValue ("kind", 99)) @>
```

Именно этот случай ловит подстановку варианта по умолчанию — самый тихий дефект отображения контракта.
- Workflow проверяется с фиксированными временем, UUID, random seed и ответами зависимостей. Тест не читает часы машины и не зависит от порядка соседних тестов.
- Композиция DI, SQL/Dapper, миграция, Protobuf serialization и реальный transport проверяются на integration или contract level, а не моками.
- E2E доказывает пользовательский срез и оставляет доменные комбинации нижним уровням.

## Property-based тесты

- Property формулирует инвариант, а не повторяет реализацию: недопустимый переход не меняет состояние, применение принятого события увеличивает версию один раз, encode/decode сохраняет договорённый смысл.

```fsharp
[<Property>]
let ``applying a decided event bumps version exactly once`` (order: Order) =
    match Order.decidePayment fixedNow order with
    | Error _ -> true
    | Ok event -> (Order.apply order event).Version = order.Version + 1

[<Property>]
let ``proto round trip preserves the input`` (input: PlaceOrderInput) =
    let restored = input |> Mapping.toProto |> Mapping.fromProto
    restored = Ok input
```

Round trip проверяется на том типе, который отображение действительно возвращает: `fromProto` даёт `Result<PlaceOrderInput, MappingError>`, поэтому и `toProto` берётся от `PlaceOrderInput`. Пара, собранная из разных типов, не типизируется — и это первое, что стоит проверить в таком тесте.

- Generator создаёт только валидный тип, если проверяется поведение домена; невалидный primitive генерируется отдельно для boundary constructor.
- Приватный конструктор доменного типа FsCheck не останавливает: он собирает значение рефлексией и выдаёт, например, `Quantity 0` при инварианте «строго больше нуля». Поэтому доменный тип с инвариантом получает собственный `Arbitrary`, иначе property проверяет значения, которые система не способна произвести.

```fsharp
type DomainArbitraries =
    static member Quantity () =
        Gen.choose (1, 1000)
        |> Gen.map (fun n ->
            match Quantity.create n with
            | Ok q -> q
            | Error _ -> failwith "unreachable")
        |> Arb.fromGen

[<Property(Arbitrary = [| typeof<DomainArbitraries> |])>]
let ``quantity survives round trip`` (quantity: Quantity) =
    Quantity.create (Quantity.value quantity) = Ok quantity
```
- Найденный FsCheck counterexample сохраняется как обычный regression example, если он описывает важный край предметной области.

## Test doubles

Порядок выбора: чистая функция, record of functions, маленький handwritten fake, и только затем Moq.

```fsharp
// База с честными отказами: тест переопределяет ровно то поле, которое ему нужно
let private notImplemented name = fun _ -> failwithf "%s is not expected in this test" name

let private stubDeps: Workflow.Deps =
    { LoadOrder = notImplemented "LoadOrder"
      SaveOrder = notImplemented "SaveOrder"
      Now = fun () -> fixedNow
      Logger = NullLogger.Instance }

[<Fact>]
let ``missing order is reported as NotFound`` () =
    let deps = { stubDeps with LoadOrder = fun _ -> Task.FromResult None }

    let result = Workflow.execute deps command |> Async.AwaitTask |> Async.RunSynchronously

    test <@ result = Error (PayOrderError.NotFound command.OrderId) @>
```

- Поле, которое тест не переопределил, обязано падать с внятным сообщением. Заглушка, молча возвращающая `None` или пустой список, превращает пропущенный вызов в зелёный тест.
- Состояние, нужное для нескольких вызовов workflow, хранится в узком handwritten fake с явным поведением.

```fsharp
type OrderStore () =
    let saved = ResizeArray<Order> ()

    member _.Saved = List.ofSeq saved

    member _.AsDeps (initial: Order option) =
        { stubDeps with
            LoadOrder = fun _ -> Task.FromResult initial
            SaveOrder = fun order _ -> saved.Add order; Task.FromResult () }
```

Проверяется наблюдаемый результат — что именно сохранено, — а не цепочка вызовов.

- Moq используется для .NET-интерфейса, lifecycle или взаимодействия с библиотекой, где fake дороже и менее прозрачен. Проверяй минимально значимое взаимодействие; не повторяй весь implementation sequence через `Verify`.

```fsharp
[<Fact>]
let ``connection is released after a failed command`` () =
    let connection = Mock<IDbConnection> ()
    let factory = Mock<IDbConnectionFactory> ()
    factory.Setup(fun f -> f.Create ()).Returns (connection.Object) |> ignore

    runFailingCommand factory.Object

    connection.Verify ((fun c -> c.Dispose ()), Times.Once)
```
- F#-record и DU не мокаются: их создают значением.
- PostgreSQL, NATS и gRPC не объявляются проверенными тестом над mock-клиентом. Для них нужен соответствующий integration или contract test.

```fsharp
type PostgresFixture () =
    let container = PostgreSqlBuilder("postgres:17-alpine").Build ()

    member _.ConnectionString = container.GetConnectionString ()

    interface IAsyncLifetime with
        member _.InitializeAsync () = ValueTask (container.StartAsync ())
        member _.DisposeAsync () = container.DisposeAsync ()
```

Два места, где легко ошибиться: конструктор `PostgreSqlBuilder` без образа помечен obsolete, а `IAsyncLifetime` в xUnit v3 возвращает `ValueTask`, а не `Task` — отсюда обёртка вокруг `StartAsync`.

## Проверка

- Запусти самый узкий настроенный test project или class filter, затем общий one-shot test command компонента.
- Для xUnit v3 фильтрация выполняется поддерживаемыми runner arguments проекта; не копируй команды xUnit v2 или старого VSTest без проверки `--help` текущего runner.
- Тест стабильно воспроизводит failure, не ходит в production и освобождает поднятые ресурсы.
- Проверь, что тест краснеет при нарушении заявленного свойства, а не только зеленеет на текущей реализации.
- Для изменения контракта дополнительно применяется [Protobuf standard](../contracts/protobuf.md) и `proj-change-contract`.
