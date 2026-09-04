# Standard: функциональные вертикальные срезы F#

> **Статус:** Active  
> **Применимость:** F#-приложения, для которых это устройство выбрано отдельным решением; сейчас Meetups по [ADR-033](../../decisions/ADR-033-meetups-functional-vertical-slices.md)  
> **Связанные документы:** [languages/fsharp.md](../languages/fsharp.md), [testing/fsharp.md](../testing/fsharp.md), [contracts/protobuf.md](../contracts/protobuf.md), [ADR-025](../../decisions/ADR-025-meetups-fsharp-stack.md)

Норматив задаёт устройство F#-приложения, собранного вокруг команд и запросов: где живёт чистое решение, как выражаются зависимости, как течёт ошибка и где заканчиваются HTTP, SQL и Protobuf.

Сам факт использования F# этот standard не включает. Компонент попадает под него, когда устройство выбрано решением; для другого F#-сервиса допустимо иное устройство своим ADR.

Примеры написаны на нейтральном домене заказов. Они показывают форму, а не проектируют конкретный сервис: доменный словарь Meetups задаёт [ADR-031](../../decisions/ADR-031-meetups-domain-vocabulary-and-event-form.md), и повторять его здесь не нужно. Код примеров собран и проверен компилятором на .NET 10 с Oxpecker; конкретные версии пакетов закрепляются при создании проекта.

## Функциональное ядро и императивная оболочка

Приложение делится не на горизонтальные слои, а на две области с разными правилами.

```text
┌── Imperative Shell ──────────────────────────────────────┐
│  HTTP handler · Dapper · Protobuf mapping · часы · UUID  │
│                                                          │
│      ┌── Functional Core ───────────────────────┐        │
│      │  типы домена, инварианты, decide/apply   │        │
│      │  детерминированно, без Task и без I/O    │        │
│      └──────────────────────────────────────────┘        │
│                                                          │
│  транзакция · публикация · ответ клиенту                 │
└──────────────────────────────────────────────────────────┘
```

- Ядро получает все факты значениями и возвращает типизированное решение. Оно не читает часы, UUID generator, random, environment, сеть, базу и глобальный mutable state.
- Оболочка добывает факты, вызывает ядро один раз на сценарий и применяет результат. Она не принимает доменных решений и не проверяет инварианты повторно.
- Граница проходит по сигнатуре: функция ядра не возвращает `Task`, не принимает `IServiceProvider`, `HttpContext`, `IDbConnection` и не открывает namespace сгенерированных контрактов.

## Срез

Срез — это одна команда или один запрос со своим входом, типизированным результатом и своим набором отказов. Он владеет оркестрацией сценария и отображениями, уникальными для него.

- Срез называется продуктовым действием: `PlaceOrder`, `PayOrder`, `ListOpenOrders`. Не `OrderService`, не `OrderHandler`, не `OrderManager`.
- Границы среза совпадают с границей транзакции сценария. Если один сценарий требует двух срезов в одной транзакции, границу выбрали неверно.
- Срез не вызывает другой срез. Общее живёт в доменных типах и в инфраструктуре, а не в цепочке workflow.
- Срез не обязан иметь фиксированный набор файлов. Количество модулей следует сложности сценария.

## Опорная анатомия

Ниже — форма, к которой сходится нетривиальный срез. Это опора для чтения и обсуждения, а не обязательный шаблон: [ADR-033](../../decisions/ADR-033-meetups-functional-vertical-slices.md) прямо отказался от фиксированного набора файлов.

| Модуль | Ответственность | Что запрещено |
|---|---|---|
| `Types` | вход, успешный результат, error DU среза | доменная логика, зависимости |
| `Workflow` | `Deps`, отображение входа в домен, оркестрация | DI-контейнер, HTTP status, SQL |
| `Adapters` | перевод инфраструктурного DTO и generated-типа в доменный | доменные решения |
| `Composition` | сборка `Deps` из зарегистрированных сервисов | бизнес-правила |
| `Api` | endpoint и отображение error DU в transport | вызовы инфраструктуры мимо `Workflow` |

```text
Domain/                 общие доменные типы и функции
Infrastructure/         тонкие клиенты: соединение, запросы, transport
Slices/
  PlaceOrder/
    Types.fs
    Workflow.fs
    Adapters.fs
    Composition.fs
    Api.fs
  ListOpenOrders/
    ListOpenOrders.fs   весь срез в одном модуле
Endpoints.fs
Program.fs
```

### Когда схлопывать и когда разделять

- Срез без собственных адаптеров и без нетривиального отображения живёт одним файлом. Пустой `Adapters.fs` с одной сквозной функцией — шум, а не структура.
- Модуль выделяется, когда у него появилась отдельная ответственность или отдельный набор зависимостей, а не ради симметрии с соседним срезом.
- Файл, определения которого зависят от разных вещей, разрезается: он лежит на границе.
- Разные срезы вправе иметь разное число файлов. Асимметрия каталогов — принятая цена, а не дефект.

Свёрнутый запрос целиком:

```fsharp
module Slices.ListOpenOrders

[<NoEquality; NoComparison>]
type Deps = { LoadOpen: unit -> Task<Order list> }

let execute (deps: Deps) : Task<OrderView list> =
    task {
        let! orders = deps.LoadOpen ()
        return orders |> List.map Slices.PayOrder.Workflow.Mapping.toView
    }
```

Заимствование `Mapping.toView` из соседнего среза — сигнал: у отображения появился второй потребитель, и оно переезжает в общий модуль ближайшей правкой. До второго потребителя оно правильно лежало внутри своего среза.

## Чистое ядро

Решение и переход состояния — две отдельные чистые функции. Первая отвечает «можно ли и что произошло», вторая — «как теперь выглядит состояние».

```fsharp
namespace Domain

type OrderStatus =
    | New
    | Paid of at: DateTimeOffset
    | Cancelled of reason: string

type Order =
    { Id: OrderId
      Status: OrderStatus
      PlacedAt: DateTimeOffset
      Version: int }

type DomainError =
    | OrderAlreadyPaid
    | OrderIsCancelled

type OrderEvent = OrderPaid of DateTimeOffset

/// Тип и его модуль-компаньон живут в одном файле.
module Order =

    /// Решение: состояние и все недетерминированные факты приходят аргументами.
    let decidePayment (now: DateTimeOffset) (order: Order) : Result<OrderEvent, DomainError> =
        match order.Status with
        | New -> Ok (OrderPaid now)
        | Paid _ -> Error OrderAlreadyPaid
        | Cancelled _ -> Error OrderIsCancelled

    /// Переход: применение события к состоянию, всегда успешное.
    let apply (order: Order) (event: OrderEvent) : Order =
        match event with
        | OrderPaid at -> { order with Status = Paid at; Version = order.Version + 1 }
```

- Тип и одноимённый модуль объявляются в одном файле. Разнести `type Order` и `module Order` по двум файлам одного namespace компилятор не позволит: это ошибка FS0250, а не вопрос вкуса.
- `decide` возвращает `Result`, `apply` — только состояние. Отказ на применении означает, что проверка стоит не там.
- Семантика команды видна в типе решения. Команда, для которой повтор — ошибка, возвращает `Result<Event, DomainError>`: `decidePayment` выше отказывает на уже оплаченном заказе. Команда, сформулированная как целевое состояние, повтором не ошибается, и её решение возвращает `Result<Event option, DomainError>` — `Ok None` означает «состояние уже такое, события нет», и оболочка отдаёт текущий снимок.

```fsharp
let decideCancellation (now: DateTimeOffset) (order: Order) : Result<OrderEvent option, DomainError> =
    match order.Status with
    | Cancelled _ -> Ok None          // уже в целевом состоянии: повтор успешен, события нет
    | New -> Ok (Some (OrderCancelled now))
    | Paid _ -> Error OrderAlreadyPaid
```

Выбрать `Result<Event, _>` для команды с целевой семантикой нельзя: идемпотентный повтор придётся выражать вариантом отказа, и вызывающая сторона перестанет отличать успех от ошибки.
- Время, идентификаторы и случайность передаются значениями. `DateTimeOffset.UtcNow` и `Guid.NewGuid ()` внутри `Domain/` — дефект.

## Зависимости

Зависимости среза выражаются минимальным record of functions. Он объявляется рядом с `execute`, а не в общем модуле.

```fsharp
module Slices.PayOrder.Workflow

[<NoEquality; NoComparison>]
type Deps =
    { LoadOrder: OrderId -> Task<Order option>
      SaveOrder: Order -> OrderEvent -> Task<unit>
      Now: unit -> DateTimeOffset
      Logger: ILogger }

module Mapping =
    let toView (order: Order) : OrderView =
        { Id = OrderId.value order.Id
          Status = string order.Status
          Version = order.Version }
```

`[<NoEquality; NoComparison>]` ставится ради явности, а не ради сборки: в конфигурации по умолчанию отсутствие атрибутов не даёт ни одного предупреждения — FS1178 включается флагом `--warnon:1178`. Сравнить две такие записи всё равно нельзя: `deps1 = deps2` — ошибка компиляции FS0001, потому что поле-функция не удовлетворяет ограничению равенства. Атрибуты объявляют это намерением типа, а не оставляют выясняться на месте использования. Копирование `{ deps with … }` они не задевают — именно так тест подменяет одно поле.

| Форма | Когда |
|---|---|
| отдельные функции-аргументы | одна-две зависимости, срез в одном файле |
| record of functions | три и более, либо несколько вызовов подряд |
| .NET-интерфейс | interop с библиотекой, где интерфейс уже есть — `ILogger`, `IDbConnectionFactory` |

- `IServiceProvider`, container lookup и scoped-резолв не проходят внутрь `Workflow`. Их место — `Composition`.
- `ILogger` передаётся интерфейсом намеренно: уровни и структурированные поля неудобно выражать одной функцией. Поля записи задаёт [logging standard](../observability/logging.md).
- Общий `Deps` на несколько срезов не заводится. Совпадение полей у двух срезов сегодня — совпадение, а не абстракция.

### Оркестрация

```fsharp
let execute (deps: Deps) (command: PayOrderCommand) : Task<Result<OrderView, PayOrderError>> =
    task {
        match! deps.LoadOrder command.OrderId with
        | None -> return Error (PayOrderError.NotFound command.OrderId)
        | Some order ->
            match Order.decidePayment (deps.Now ()) order with
            | Error domainError -> return Error (PayOrderError.Domain domainError)
            | Ok event ->
                let updated = Order.apply order event
                do! deps.SaveOrder updated event
                return Ok (Mapping.toView updated)
    }
```

Вложенность `match` — цена того, что библиотека error-handling computation expressions в проекте не выбрана: [ADR-025](../../decisions/ADR-025-meetups-fsharp-stack.md) закрепил только F#, Dapper и способ кодогенерации. `FsToolkit.ErrorHandling` или другой аналог вводится отдельным решением вместе с обновлением этого раздела, а не локально внутри среза.

### Composition root

```fsharp
module Slices.PayOrder.Composition

let buildDeps (sp: IServiceProvider) : Workflow.Deps =
    let connections = sp.GetRequiredService<IDbConnectionFactory> ()
    { LoadOrder = Adapters.loadOrder connections
      SaveOrder = Infrastructure.Orders.saveWithEvent connections
      Now = fun () -> DateTimeOffset.UtcNow
      Logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger "PayOrder" }
```

- Контейнер DI заканчивается здесь. Ниже `Composition` живут только функции и значения.
- Lifetime и disposal ресурсов принадлежат регистрации в `Program.fs`; срез не открывает и не закрывает соединение сам, если этого не требует его транзакция.
- Каждый срез собирает свои зависимости. Единый `AppDeps` со всеми функциями сервиса запрещён: он возвращает связность, ради устранения которой выбраны срезы.

## Ошибки

Ошибка проходит три уровня, и каждый переход — явное отображение.

| Уровень | Тип | Где объявлен | Пример |
|---|---|---|---|
| домен | `DomainError` | `Domain/` | `OrderAlreadyPaid` |
| срез | `PayOrderError` | `Types` среза | `Domain of DomainError`, `NotFound of OrderId`, `Storage of exn` |
| transport | HTTP status, gRPC code | `Api` среза | 409, 404, 500 |

```fsharp
[<RequireQualifiedAccess; NoComparison>]
type PayOrderError =
    | NotFound of OrderId
    | Domain of DomainError
    | Storage of exn
```

`[<NoComparison>]` объявляет то, что и так следует из поля `exn`: упорядочить такой DU нельзя. По умолчанию это не предупреждение — FS1178 включается флагом `--warnon:1178`, — но атрибут делает свойство типа видимым в объявлении. `[<RequireQualifiedAccess>]` работает иначе: он реально меняет разрешение имён и заставляет писать `PayOrderError.NotFound`. Без него одноимённые варианты соседних срезов перекрывают друг друга по правилу последнего открытого модуля, и `match` собирается не с тем вариантом.

```text
OrderAlreadyPaid ──► PayOrderError.Domain ──► 409
OrderIsCancelled ──► PayOrderError.Domain ──► 409
      (нет строки) ─► PayOrderError.NotFound ─► 404
        exn от БД ──► PayOrderError.Storage ──► 500
```

- Каждый срез объявляет свой error DU. Общий `AppError` с вариантами `Validation | NotFound | Conflict | Infrastructure` запрещён: он заставляет обрабатывать невозможные для среза случаи и убивает проверку полноты.
- Домен не возвращает `Unauthorized` и `Forbidden`: это политика границы, а не бизнес-инвариант.
- Отображение выполняется исчерпывающим `match`. Catch-all `| _ ->` в `mapError` скрывает новый вариант и запрещён.
- Недоступность соседа не превращается в пустой успешный результат и не маскируется доменным отказом.
- Неожиданное исключение сохраняет причину: `Storage of exn`, а не `Storage of string`.

## Границы

### HTTP

Oxpecker выбран [ADR-033](../../decisions/ADR-033-meetups-functional-vertical-slices.md) для HTTP-границы приложения, когда она нужна.

```fsharp
module Slices.PayOrder.Api

let private toErrorResponse (error: PayOrderError) : EndpointHandler =
    match error with
    | PayOrderError.NotFound _ -> setStatusCode 404 >=> json {| error = "order not found" |}
    | PayOrderError.Domain OrderAlreadyPaid -> setStatusCode 409 >=> json {| error = "already paid" |}
    | PayOrderError.Domain OrderIsCancelled -> setStatusCode 409 >=> json {| error = "cancelled" |}
    | PayOrderError.Storage _ -> setStatusCode 500 >=> json {| error = "storage failure" |}

let handler: EndpointHandler =
    fun ctx ->
        task {
            let deps = Composition.buildDeps ctx.RequestServices
            let! command = ctx.BindJson<PayOrderCommand> ()

            match! Workflow.execute deps command with
            | Ok view -> return! json view ctx
            | Error error -> return! toErrorResponse error ctx
        }
```

- Отображение отказа собирает `EndpointHandler` композицией `>=>` и применяется к контексту в самом конце. Так ветка отказа остаётся значением, которое видно целиком.
- `EndpointHandler`, `HttpContext`, route и status code не проходят глубже `Api`. Домен и `Workflow` о HTTP не знают.
- Выбор Oxpecker относится к HTTP-границе приложения. Он не выбирает transport межсервисных операций: gRPC и NATS определяются их failure semantics и Protobuf-контрактами.

### PostgreSQL

- Dapper и SQL живут в `Infrastructure/` либо в адаптерах среза. SQL-строка не попадает в `Workflow` и в домен.
- Строка таблицы отображается в доменный тип в адаптере. Анемичная запись со строковыми полями внутрь домена не проходит.

```fsharp
let private toDomain (row: OrderRow) : Result<Order, string> =
    match OrderId.parse row.Id, OrderStatus.parse row.Status with
    | Ok id, Ok status ->
        Ok { Id = id; Status = status; PlacedAt = row.PlacedAt; Version = row.Version }
    | _ -> Error $"malformed order row {row.Id}"

let loadOrder (connections: IDbConnectionFactory) (id: OrderId) : Task<Order option> =
    task {
        match! Infrastructure.Orders.findById connections id with
        | None -> return None
        | Some row ->
            match toDomain row with
            | Ok order -> return Some order
            | Error message -> return failwith message
    }
```

Битая строка — нарушение внутреннего контракта, а не ожидаемый отказ домена, поэтому здесь исключение, а не вариант error DU.
- Изменение состояния и запись доменного события выполняются одной функцией адаптера, чтобы транзакционная граница была видна в сигнатуре, а не собиралась по вызовам.

### Protobuf и C#

- Сгенерированный C#-проект контрактов остаётся generated-only ([ADR-025](../../decisions/ADR-025-meetups-fsharp-stack.md), [protobuf standard](../contracts/protobuf.md#кодогенерация-net)). Отображение живёт в F#-адаптере.
- Адаптер проверяет обязательность, диапазоны и неизвестные варианты до вызова домена. После успешного отображения эти проверки внутри среза не повторяются.
- Неизвестный вариант enum — явный отказ отображения, а не молчаливое значение по умолчанию.

## Общий код

Общий модуль появляется после второго реального потребителя. До этого код остаётся в срезе, ради которого написан.

Границу между инфраструктурой и общей склейкой компилятор не держит: `Infrastructure/` компилируется раньше срезов, поэтому «инфраструктура не знает про срезы» гарантировано, а обратное — нет. Инфраструктурный файл может открыть любой namespace контрактов, и сборка останется зелёной.

| Функция знает про | Место |
|---|---|
| один внешний протокол плюс примитивы и value objects | `Infrastructure/` |
| два контракта и переводит один в другой | общий модуль срезов |
| один сценарий | сам срез |

Проверочные вопросы перед добавлением файла в `Infrastructure/`:

- открывает ли он ровно один чужой namespace контрактов;
- если он открывает и наши типы — это словарь значений (`OrderId`, `Money`), а не целевая модель отображения;
- останется ли функция осмысленной, если удалить все срезы приложения.

Любое «нет» означает, что файл принадлежит общему модулю срезов, а не инфраструктуре.

Имена `Utils`, `Helpers`, `Common` без названной ответственности запрещены. Модуль, собравший две несвязанные заботы, разрезается.

## Порядок компиляции

В F# порядок `<Compile Include>` и есть направление зависимостей: файл видит только объявленное раньше.

```xml
<ItemGroup>
  <Compile Include="Domain/Types.fs" />
  <Compile Include="Domain/Order.fs" />
  <Compile Include="Infrastructure/Db.fs" />
  <Compile Include="Infrastructure/Orders.fs" />
  <Compile Include="Slices/PayOrder/Types.fs" />
  <Compile Include="Slices/PayOrder/Workflow.fs" />
  <Compile Include="Slices/PayOrder/Adapters.fs" />
  <Compile Include="Slices/PayOrder/Composition.fs" />
  <Compile Include="Slices/PayOrder/Api.fs" />
  <Compile Include="Endpoints.fs" />
  <Compile Include="Program.fs" />
</ItemGroup>
```

- `Infrastructure/` идёт выше срезов: адаптеры среза ссылаются на инфраструктурные типы, а не наоборот. Это отличается от привычной картинки Clean Architecture и следует из модели компиляции F#.
- Новый файл ставится в минимально необходимое место, а не в конец списка.
- Цикл между срезами исправляется изменением границ, а не общим модулем и не копированием типа.
- Перестановка записей `.fsproj` ради устранения ошибки компиляции требует проверки, что слои не инвертированы.

## Проверка

- Каждый срез читается как один сценарий: вход, решение, эффект, результат.
- Функция домена не возвращает `Task`, не принимает контекст фреймворка и не читает недетерминированный источник.
- `Deps` содержит только то, что срез действительно вызывает; `IServiceProvider` внутри среза отсутствует.
- Error DU объявлен на уровне среза, отображение исчерпывающее, причина неожиданного отказа сохранена.
- Generated-типы, `HttpContext` и строки таблиц не пересекли адаптер.
- Общий модуль имеет минимум два реальных потребителя.
- Порядок `.fsproj` соответствует направлению зависимостей и обновлён в том же изменении.
- Тесты выбраны по [testing/fsharp.md](../testing/fsharp.md): решение и переход — чистыми unit-тестами, транзакция и SQL — интеграционными.
