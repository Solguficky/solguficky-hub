# Доменные типы на Scala 3

Разбор объясняет, какими средствами языка собрано ядро лота в `apps/auction`: закрытые наборы через `enum` и `sealed trait`, значение с инвариантом через закрытый конструктор, отказ как значение `Either` и исчерпывающий `match`. Читателю не нужно знать Scala; знание C# и F# помогает, и где аналогия есть, она названа вместе с отличием.

Опора — код `apps/auction/src/main/scala/auction/lot/` из PER-297 и временная спека-зонд из той же сессии: она проверяла через `scala.compiletime.testing.typeCheckErrors`, какие выражения компилируются, и её вывод приведён ниже. Правила формы задаёт [scala.md](../../standards/languages/scala.md), устройство решения — [RFC-011](../../rfcs/RFC-011-auction-trading-domain-model.md) и [ADR-047](../../decisions/ADR-047-auction-trading-domain-vocabulary-and-event-form.md).

## Механика

### Закрытый набор: `enum` и `sealed trait`

Фаза торгов — одно из двух значений, отказ приёма ставки — одно из шести. В Scala 3 такой набор пишется `enum`:

```scala
enum PlaceBidRejected {
  case LotNotOpen
  case LotOnHold
  case CurrencyMismatch
  case BidderIsLeader
  case BidNotAtNextPrice(expected: Money)
  case BidBelowMinimum(minRequired: Money)
}
```

В отличие от `enum` в C#, случай здесь может нести данные: `BidNotAtNextPrice` хранит цену, которую отказ называет. По смыслу это размеченное объединение F# (`type Rejected = | LotNotOpen | BidNotAtNextPrice of Money`), а не набор целых чисел.

Та же сумма пишется и старым способом — запечатанным трейтом и классами-наследниками. `sealed` значит «все наследники лежат в этом файле», и компилятор знает их полный список. В ядре так записана политика шага:

```scala
sealed trait StepPolicy { def currency: CurrencyCode }
object StepPolicy {
  final case class Fixed private[StepPolicy] (step: Money) extends StepPolicy { … }
  final case class Tiered private[StepPolicy] (base: Money, tiers: List[Tier]) extends StepPolicy { … }
```

Разница в том, что понадобилось: у `StepPolicy` конструктор случаев должен быть закрыт. Можно ли закрыть конструктор у случая `enum`, в этом срезе не проверялось — проверь сам, когда будет чем: временный файл с `enum E { case A private (x: Int) }` и `sbt Test/compile`.

### Исчерпывающий `match`

Раз компилятор знает все случаи запечатанной суммы, он проверяет, что `match` разобрал каждый. Зонд с `match` по `LotState`, где забыт `Held`, дал предупреждение:

```text
[E029] Pattern Match Exhaustivity Warning: … match may not be exhaustive.
It would fail on pattern case: auction.lot.LotState.Held(_)
```

На этом держится обещание в комментарии к `LotState`: соседние задачи добавят состояния случаями, и компилятор сам покажет каждый `match`, где их надо обработать. Работает это, только пока в решающей ветке нет `case _ =>`: ветка «всё остальное» закрывает проверку и прячет новый случай. В `Lot.decide` ветки по состоянию перечислены явно; в `Lot.apply` есть `case (other, _) => other`, и там это осознанно — событие, которое к состоянию не относится, состояние не меняет.

Предупреждение — не ошибка: `-Werror` в `build.sbt` не включён, и сборка с неполным `match` пройдёт.

### Значение с инвариантом: закрытый конструктор

Политика шага `Tiered` обязана быть непротиворечивой (И-15): непустой список, первая граница ноль, границы растут, шаги положительны. Закрытый конструктор делает противоречивое значение непредставимым: получить `StepPolicy` можно только через функцию, которая проверила инвариант.

`case class` в Scala синтезирует несколько методов: `apply` в компаньоне (чтобы писать `Fixed(m)` без `new`), `copy`, `unapply` для сопоставления с образцом, `equals`. Квалификатор `private[StepPolicy]` у конструктора ограничивает доступ объектом `StepPolicy`, и зонд показал, что происходит с каждым синтезированным методом снаружи:

```text
PROBE ctor-apply: object Fixed in object StepPolicy does not take parameters
PROBE ctor-new:   constructor Fixed cannot be accessed as a member of auction.lot.StepPolicy.Fixed
PROBE copy:       method copy cannot be accessed as a member of (fixed : auction.lot.StepPolicy.Fixed)
PROBE unapply:    (компилируется)
```

То есть `apply` и `copy` закрылись вместе с конструктором — иначе `copy(step = Money(0, …))` обошёл бы проверку, — а разбор `case StepPolicy.Fixed(step) =>` открыт: читать значение можно, собрать в обход нельзя. Квалификатор именно `[StepPolicy]`, а не просто `private`: иначе конструктор был бы закрыт и от самого объекта `StepPolicy`, который строит значения.

Граница у квалификатора — область, а не файл. `LotConfig` объявлен `private[lot]`, и зонд в подпакете `auction.lot.probe` собрал его конструктором в обход `LotConfig.of`: `private[lot]` открывает доступ всему пакету `lot` вместе с подпакетами. Инвариант держится, пока код ядра сам его соблюдает.

Аналог в C# — `private` конструктор и статический фабричный метод. Отличие в том, что у `case class` есть синтезированные пути сборки кроме конструктора, и закрывать нужно их все; здесь это делает один квалификатор.

### Деньги без плавающей точки по типу

`Money(minorUnits: Long, currency: CurrencyCode)` — копейки целым числом. Запрет `Double` и `BigDecimal` из критерия приёмки держит не тест, а тип поля:

```text
PROBE double:     Found: (1.5d : Double)  …
PROBE bigdecimal: Found: BigDecimal  …
```

Оба выражения `Money(1.5, …)` и `Money(BigDecimal(1), …)` не компилируются: неявного сужения `Double` в `Long`, в отличие от расширения `Int` в `Long`, в Scala нет.

### Отказ — значение, а не исключение

Решение `Lot.decide` возвращает `Either[PlaceBidRejected, Decision]`: слева отказ, справа исход. Это `Result<'T, 'E>` из F#, только стороны переставлены — ошибка слева. `Either` в Scala 2.12+ смещён вправо: `map` и `flatMap` работают с правой стороной, поэтому

```scala
placeBid(trading, command, bidId).map(Decision.Accepted(_))
```

оборачивает только успех, а отказ проходит насквозь. Отказ не бросается исключением по правилу [scala.md](../../standards/languages/scala.md): ожидаемый исход домена — значение, которое тест сравнивает `shouldBe`, а не ловит.

### Перегрузка `apply` в компаньоне

У `final case class Lot` компилятор синтезирует `Lot.apply(state, seen)`, а ядро кладёт рядом свою функцию `Lot.apply(lot, envelope)` — имя из пары `decide`/`apply` RFC. Это перегрузка по типам параметров. При реализации передача перегруженного метода функцией (`foldLeft(from)(apply)`) была заменена явной лямбдой из опасения неоднозначности. Зонд показал, что опасение лишнее: `List.empty[Envelope].foldLeft(lot)(Lot.apply)` компилируется — Scala 3 выбирает перегрузку по ожидаемому типу функции `(Lot, Envelope) => Lot`. Лямбда осталась и читается явнее, но необходимой не была.

## Урок

- **Инвариант держит тип, а не проверка на каждом входе.** Значение, которое нельзя построить противоречивым, не нужно проверять ни в `decide`, ни в `apply`; `apply` поэтому может не отказывать вовсе. Тот же приём в F# — приватный конструктор объединения и модуль с `create`, в Go — неэкспортированное поле и конструктор-функция.
- **Закрыть конструктор — значит закрыть все пути сборки.** В языке с синтезированными методами обход прячется в них, например в `copy`; проверять нужно все пути сборки, а не только `new`.
- **Исчерпывающий `match` — это механизм расширения.** Добавленный случай суммы сам находит места, где его ещё не обработали, если в решающих ветках нет `case _`.

## Почему так, а не иначе

- **`opaque type Amount = Long` вместо `Money` с валютой.** Предлагался одним из планировщиков: сложить разные валюты не даёт тип. Отвергнут: ADR-047 требует валюту в каждой сумме, а владелец отклонил сопутствующий потолок суммы.
- **Проверка И-15 в `decide`.** Проще в одну строку, но тогда противоречивая политика существует в состоянии и каждое правило должно помнить о ней; RFC-011 прямо переносит проверку на вход, и закрытый конструктор делает это по построению.
- **Один отказ `StepPolicyInvalid` строкой причины.** Короче, но строку нельзя ни сопоставить, ни перечислить в тесте — тот же довод, по которому RFC-011 отказался от `BidRejected("Minimum bid required: …")`.
- **Арифметика `Money` открытой.** Удобнее тестам, но `plus` берёт валюту левого операнда и не сверяет правый. Операции закрыты `private[lot]`: складывать суммы может только ядро, где валюта уже проверена.

## Первоисточники

- [Scala 3 Reference: Enumerations](https://docs.scala-lang.org/scala3/reference/enums/enums.html) — `enum` со случаями-данными и его связь с `sealed`.
- [Scala 3 Book: Algebraic Data Types](https://docs.scala-lang.org/scala3/book/types-adts-gadts.html) — суммы через `enum` и через `sealed trait`.
- [API Scala 3.3.7: `scala.compiletime.testing`](https://scala-lang.org/api/3.3.7/scala/compiletime/testing.html) — `typeCheckErrors`, которым зонд проверял, что компилируется; версия та же, что в `build.sbt`.
- [scala.md](../../standards/languages/scala.md) — правила «тип вместо `String`», «`final case class`», «отказ — значение».
- `.skillshare/skills/proj/proj-write-scala/SKILL.md` — правило «значение с инвариантом получает приватный конструктор и `apply`, возвращающий `Either`».

## Проверь себя

- **Можно ли снаружи `StepPolicy` получить `Fixed` с нулевым шагом через `copy`?** Нет. Временная спека в пакете `auction.lot.probe` с `typeCheckErrors("fixed.copy(step = Money(0, CurrencyCode(\"R\")))")` возвращает `method copy cannot be accessed`.
- **Что скажет компилятор о `match` по `LotState` без `Held`?** Предупреждение `E029 … It would fail on pattern case: auction.lot.LotState.Held(_)` при `sbt Test/compile`, но не ошибку.
- **Соберётся ли `LotConfig(...)` в обход `LotConfig.of` из подпакета `auction.lot.probe`?** Да: `typeCheckErrors` вернул пустой список, `private[lot]` открыт подпакетам.
- **Компилируется ли `foldLeft(lot)(Lot.apply)` при перегруженном `apply`?** Да, тот же зонд вернул пустой список ошибок.
