# Standard: F#-код

> **Статус:** Active  
> **Применимость:** F#-код и `.fsproj` во всех компонентах  
> **Связанные документы:** [architecture/functional-slices.md](../architecture/functional-slices.md), [testing/fsharp.md](../testing/fsharp.md), [contracts/protobuf.md](../contracts/protobuf.md), service-local README и nested `AGENTS.md`

Норматив задаёт общую форму F#-кода: типы, чистоту доменных функций, явные зависимости, ошибки и interop. Устройство приложения — раскладку по срезам, состав composition root и границы транзакции — задаёт [architecture/functional-slices.md](../architecture/functional-slices.md) там, где это устройство выбрано отдельным решением; для Meetups это [ADR-033](../../decisions/ADR-033-meetups-functional-vertical-slices.md).

Примеры написаны на нейтральном домене и показывают форму, а не проектируют сервис. Код примеров собран и проверен компилятором на .NET 10.

## Типы и состояние

- Рабочие данные неизменяемы по умолчанию. Изменяемое состояние допускается внутри узкой инфраструктурной границы, когда этого требует внешний API или измеренная стоимость копирования.
- Взаимоисключающие состояния выражаются discriminated union, отсутствие значения — `option`, а не набором связанных `bool`, nullable и optional-полей.

```fsharp
// Нет: комбинации полей допускают невозможные состояния
type Order =
    { IsPaid: bool
      PaidAt: DateTimeOffset option
      IsCancelled: bool
      CancelReason: string }

// Да: недопустимое состояние невыразимо
type OrderStatus =
    | New
    | Paid of at: DateTimeOffset
    | Cancelled of reason: string
```

- Primitive превращается в value object или private single-case union, если у значения есть инвариант либо его можно перепутать с primitive другого смысла. Проверка выполняется один раз в функции создания.

```fsharp
type Quantity = private Quantity of int

module Quantity =
    let create (value: int) =
        if value <= 0 then Error (NonPositiveQuantity value)
        else Ok (Quantity value)

    let value (Quantity v) = v
```

Конструктор помечен `private`, поэтому значение нельзя собрать в обход проверки. Модуль-компаньон носит имя типа и даёт `create`, возвращающий `Result`, и `value` для обратного перехода. Тип и одноимённый модуль объявляются в одном файле: разнести их по двум файлам одного namespace компилятор не позволит (FS0250).

Приватность конструктора — правило компилятора, а не гарантия рантайма: рефлексия собирает значение в обход `create`. Это важно для FsCheck, который так и делает, — см. [F# testing standard](../testing/fsharp.md#property-based-тесты).

- Pattern matching по закрытому набору вариантов остаётся исчерпывающим. Catch-all не скрывает новый case, если компилятор способен проверить полноту.

```fsharp
// Нет: добавление варианта в OrderStatus не вызовет ни одного warning
match order.Status with
| Paid at -> receipt at
| _ -> ()

// Да: новый вариант ломает компиляцию там, где решение действительно принимается
match order.Status with
| New -> awaitPayment ()
| Paid at -> receipt at
| Cancelled reason -> notifyCancelled reason
```

- Публичная сигнатура модуля должна показывать допустимые входы, результаты и эффекты; внутреннее представление типа скрывается, если его можно собрать в недопустимом состоянии.

## Чистое ядро и эффекты

- Доменная функция детерминирована: одинаковый вход даёт одинаковый результат и не читает часы, UUID generator, random, environment, сеть, базу или глобальный mutable state.

```fsharp
// Нет: результат зависит от машины, тест обязан подстраиваться под часы
let expire (order: Order) =
    if order.PlacedAt.AddDays 3.0 < DateTimeOffset.UtcNow then Some Expired else None

// Да: факт приходит значением, тест задаёт его прямо
let expire (now: DateTimeOffset) (order: Order) =
    if order.PlacedAt.AddDays 3.0 < now then Some Expired else None
```

- Время, идентификаторы, случайность и данные внешних систем вычисляются в императивной оболочке и передаются в чистое ядро значениями.
- Зависимость передаётся значением: функцией или record of functions. `IServiceProvider`, container lookup и scoped service не проходят внутрь функции, принимающей решение; создание и disposal остаются у того, кто владеет ресурсом. Где именно проходит эта граница и как называется собирающий её модуль — вопрос устройства компонента, а не языка.

```fsharp
[<NoEquality; NoComparison>]
type Deps =
    { LoadOrder: OrderId -> Task<Order option>
      SaveOrder: Order -> Task<unit>
      Now: unit -> DateTimeOffset }
```

`[<NoEquality; NoComparison>]` на record с полями-функциями ставится ради явности. Сборку он не чинит: по умолчанию его отсутствие не даёт предупреждений — FS1178 включается флагом `--warnon:1178`, — а сравнение `deps1 = deps2` и без атрибутов остаётся ошибкой компиляции FS0001. Атрибут объявляет это свойством типа, а не оставляет выясняться на месте использования.

- Общий модуль появляется после второго реального потребителя. До этого код остаётся рядом со сценарием, ради которого написан.

## Ошибки

- Ожидаемый отказ моделируется именованным DU конкретного домена или use case и возвращается через `Result`. Строка не служит внутренним error protocol.

```fsharp
// Нет: вызывающая сторона вынуждена разбирать текст
let pay order : Result<Order, string> = ...

// Да: варианты перечислены, компилятор проверяет полноту обработки
type DomainError =
    | OrderAlreadyPaid
    | OrderIsCancelled

[<RequireQualifiedAccess; NoComparison>]
type PayOrderError =
    | NotFound of OrderId
    | Domain of DomainError
    | Storage of exn
```

`[<RequireQualifiedAccess>]` на error DU уровня use case обязателен: варианты вроде `NotFound` встречаются в нескольких срезах, и без квалификации они перекрывают друг друга при открытии модулей. `[<NoComparison>]` объявляет то, что и так следует из поля `exn`: упорядочить такой DU нельзя. В отличие от `[<RequireQualifiedAccess>]`, он ничего не меняет в разрешении имён и по умолчанию не влияет на предупреждения.

- Слои отображают ошибки исчерпывающим pattern match: внешний клиент — в локальный отказ, use case — в transport response. Wire-код или HTTP status не проникает в доменный DU.
- Исключение означает неожиданный технический отказ или нарушение внутреннего контракта. При преобразовании исключения сохраняется исходная причина; широкое `with _` без повторного выброса или записи причины запрещено.

```fsharp
// Нет: причина потеряна, отказ инфраструктуры выглядит как пустой результат
try
    load id
with _ -> None

// Да: причина сохранена в варианте отказа
try
    load id |> Ok
with ex -> Error (PayOrderError.Storage ex)
```

- Нельзя превращать недоступность соседа в пустой успешный результат или доменный отказ, если продуктовая семантика различает эти случаи.

## Границы .NET, C# и Protobuf

- Nullable reference, C# DTO, database row и generated Protobuf message заканчиваются в адаптере. Внутри trusted boundary используются F# records, DU, `option` и value objects.

```fsharp
let fromProto (message: PlaceOrderRequest) : Result<PlaceOrderInput, MappingError> =
    match OrderId.parse message.OrderId with
    | Error _ -> Error (InvalidField "order_id")
    | Ok orderId ->
        match message.Kind with
        | OrderKind.Standard -> Ok { OrderId = orderId; Kind = Standard }
        | OrderKind.Express -> Ok { OrderId = orderId; Kind = Express }
        | unknown -> Error (UnknownEnumValue ("kind", int unknown))
```

Неизвестный вариант enum — явный отказ отображения, а не молчаливое значение по умолчанию: `protoc` порождает вариант `0` для любого нераспознанного числа, и `| _ -> Standard` превратил бы чужую версию схемы в тихо неверные данные.

- Отображение границы проверяет обязательность, диапазоны и неизвестные варианты до вызова домена. После успешного отображения эти проверки внутри workflow не повторяются.
- Сгенерированный C#-проект контрактов остаётся generated-only по [стандарту Protobuf](../contracts/protobuf.md#кодогенерация-net): extension methods, валидация и доменные helpers в него не добавляются.
- Асинхронная форма следует API границы. `Task` используется на .NET/ASP.NET Core interop boundary; переход в другой computation type требует существующего проектного соглашения, а не локального предпочтения.

Библиотека error-handling computation expressions в проекте не выбрана. `Result` внутри `task` разбирается штатным `match`; ввод `FsToolkit.ErrorHandling` или аналога — отдельное решение, а не локальное предпочтение автора среза.

## Модули и порядок компиляции

- Порядок `<Compile Include>` в `.fsproj` меняется вместе с кодом и следует направлению зависимостей: файл может ссылаться только на объявленное раньше.

```xml
<ItemGroup>
  <Compile Include="Domain/Types.fs" />
  <Compile Include="Domain/Order.fs" />
  <Compile Include="Infrastructure/Orders.fs" />
  <Compile Include="Slices/PayOrder/Workflow.fs" />
  <Compile Include="Program.fs" />
</ItemGroup>
```

- Новый файл ставится в минимально необходимое место, а не автоматически в конец. Цикл зависимостей исправляется изменением границ модулей, не копированием типов.
- Namespace обозначает устойчивую область владения; modules используются для функций и деталей конкретного сценария. Имена `Utils`, `Helpers`, `Common` без названной ответственности запрещены.
- Тип и его модуль-компаньон лежат в одном файле. Одинаковое имя типа и модуля в разных файлах одного namespace — ошибка компиляции FS0250, поэтому «типы отдельно, функции отдельно» здесь не работает.

## Проверка

- `dotnet build` проходит без новых warnings либо warning имеет узкое документированное подавление.
- Exhaustiveness warnings не подавлены catch-all веткой.
- Expected error виден в возвращаемом типе, а unexpected failure сохраняет причину.
- C#/Protobuf/nullable типы не прошли за boundary mapping.
- Порядок `.fsproj` соответствует реальным зависимостям.
- Тесты выбраны по [F# testing standard](../testing/fsharp.md).
- Для компонента с выбранным устройством дополнительно применяется [architecture/functional-slices.md](../architecture/functional-slices.md).
