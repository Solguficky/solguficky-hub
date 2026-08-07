# ADR-017: Технологический стек Auction Service

**Дата**: 24.10.2025

**Статус**: Принято

### Контекст

Auction Service — это ключевой stateful-сервис платформы, отвечающий за проведение торгов. Требования к сервису:

1. **Event Sourcing** — полный аудит всех событий аукциона
2. **Сложная бизнес-логика** — различные режимы торгов, анти-снайп, proxy-bids
3. **Конкурентность** — множество одновременных ставок
4. **Типобезопасность** — минимизация runtime ошибок
5. **Интеграция** — gRPC для синхронных запросов, NATS для команд/событий
6. **Тестируемость** — возможность unit и integration тестов без реальной БД

### Рассмотренные варианты

#### Язык программирования

**1. Scala 3 + Akka Typed**
- ✅ Мощная типизация (ADTs, sealed traits)
- ✅ Зрелая экосистема для Event Sourcing (Akka Persistence)
- ✅ Акторная модель идеальна для конкурентной бизнес-логики
- ✅ Большое community, много примеров
- ⚠️ JVM требует больше памяти
- ⚠️ Время компиляции Scala

**2. F# + Akka.NET**
- ✅ Функциональный стиль, immutability by default
- ✅ Akka.NET поддерживает Event Sourcing
- ✅ Отличная интеграция с .NET экосистемой
- ⚠️ Меньше community и примеров для Akka.NET
- ⚠️ Akka.NET менее зрелый чем Akka JVM

**3. Rust + async actors (Actix)**
- ✅ Минимальное потребление ресурсов
- ✅ Производительность
- ⚠️ Нет готового Event Sourcing фреймворка
- ⚠️ Пришлось бы писать персистентность с нуля
- ⚠️ Акторы в Actix не типобезопасны

**Выбор:** **Scala 3 + Akka Typed** — лучший баланс между зрелостью экосистемы, типобезопасностью и production-ready Event Sourcing.

#### Фреймворк для Event Sourcing

**1. Akka Persistence Typed**
- ✅ Industry standard для Event Sourcing на JVM
- ✅ Типобезопасные акторы
- ✅ Встроенная поддержка снапшотов
- ✅ Отличная документация и примеры
- ✅ EventSourcedBehaviorTestKit для тестов без БД

**2. ZIO + ZIO Actors**
- ✅ Чистый функциональный стиль
- ✅ Testability через ZIO environment
- ⚠️ Нет готового Event Sourcing (нужна библиотека типа zio-entity)
- ⚠️ Меньше примеров production использования

**Выбор:** **Akka Persistence Typed** — battle-tested решение с Event Sourcing "из коробки".

#### gRPC фреймворк

**1. akka-grpc + akka-http**
- ✅ Нативная интеграция с Akka Typed
- ✅ ask pattern работает напрямую с ActorRef
- ✅ Один ActorSystem для акторов и gRPC
- ✅ Protobuf кодогенерация через ScalaPB

**2. http4s + fs2-grpc**
- ✅ Чистый функциональный стиль (cats-effect)
- ✅ Composable через Kleisli
- ⚠️ Нужен "мост" между Akka и cats-effect (IO ↔ Future)
- ⚠️ Два runtime (ActorSystem + IORuntime)
- ⚠️ Сложнее интегрировать с Akka Persistence

**Выбор:** **akka-grpc + akka-http** — нативная интеграция с акторами, ask pattern "из коробки".

#### NATS клиент

**1. io.nats:jnats (официальный Java клиент)**
- ✅ Официальная поддержка от NATS.io
- ✅ Зрелый, хорошо протестированный
- ✅ Поддержка JetStream
- ✅ Тонкая обертка (~100 строк) решает интероп
- ⚠️ Java API (нужна конвертация Future)

**2. Самописная обертка на Akka Streams**
- ✅ Идиоматичная для Akka (Source/Sink)
- ✅ Backpressure через Akka Streams
- ⚠️ Нужно писать и поддерживать самим
- ⚠️ Риск багов, нужны тесты

**3. nats4cats (cats-effect)**
- ⚠️ Не подходит — мы не используем cats-effect

**Выбор:** **io.nats:jnats** — официальный клиент надежен, тонкая обертка не добавляет сложности.

#### Тестирование

**1. ScalaTest + Akka TestKit Typed**
- ✅ Стандарт в Akka экосистеме
- ✅ Официальная поддержка: `ScalaTestWithActorTestKit`
- ✅ `EventSourcedBehaviorTestKit` для персистентных акторов
- ✅ Множество стилей (WordSpec, FlatSpec)
- ⚠️ Медленнее компилируется

**2. MUnit + Akka TestKit**
- ✅ Легковесный, быстрый
- ✅ Лучше для Scala 3
- ⚠️ Нет официальной интеграции с Akka
- ⚠️ Придется писать обертки

**Выбор:** **ScalaTest** — официальная поддержка Akka критична для тестирования Event Sourcing.

### Решение

**Технологический стек Auction Service:**

| Компонент | Выбор |
|-----------|-------|
| **Язык** | Scala 3.5.x |
| **Build Tool** | sbt 1.10.x |
| **Фреймворк** | Akka 2.9.x Typed |
| **Event Sourcing** | Akka Persistence Typed |
| **База данных** | PostgreSQL (Event Store) |
| **gRPC** | akka-grpc + akka-http |
| **Protobuf** | akka-grpc plugin (ScalaPB) |
| **NATS клиент** | io.nats:jnats |
| **Тестирование** | ScalaTest + Akka TestKit Typed |
| **IDE** | Cursor + Metals LSP |

**Архитектурные принципы:**

1. **Domain-Driven Design:** структура domain/, application/, infrastructure/
2. **Короткие пакеты:** `auction.domain.session` вместо `io.solguficky.auction.domain.session`
3. **Event Sourcing:** события — source of truth
4. **Типобезопасность:** sealed traits для протоколов, ADTs для команд/событий
5. **Иерархия акторов:** AuctionRegistry → AuctionSession → Lot
6. **Интеграция:** gRPC для queries, NATS для commands

### Обоснование

#### Почему Akka + Scala 3?

1. **Event Sourcing "из коробки":**
   - `EventSourcedBehavior[Command, Event, State]` — готовая абстракция
   - Персистентность в PostgreSQL через `akka-persistence-jdbc`
   - Снапшоты, recovery, retention policy

2. **Акторная модель для concurrency:**
   - Каждый лот — отдельный актор с изолированным состоянием
   - Нет race conditions, нет блокировок
   - Обработка команд последовательно внутри актора

3. **Типобезопасность:**
   - `ActorRef[Protocol]` — компилятор проверяет типы сообщений
   - Sealed traits — exhaustive pattern matching
   - Компилятор предупреждает о неполном покрытии

#### Почему akka-grpc?

```scala
val sessionRef: ActorRef[AuctionSession.Command] = ...
registry
  .ask(replyTo => GetSession(eventId, replyTo))
  .flatMap(sessionRef.ask(GetStatus.apply))
  .map(status => AuctionStatusResponse(...))
```

- ask pattern работает напрямую с ActorRef
- Один ActorSystem для акторов и gRPC
- Нет конвертации между Future и IO

#### Почему io.nats:jnats?

- Официальный клиент = надежность и поддержка
- Тонкая обертка (~100 строк) решает интероп:

```scala
class NatsPublisher(connection: Connection)(using ec: ExecutionContext):
  def publish[T <: GeneratedMessage](subject: String, message: T): Future[Unit] =
    Future(connection.publish(subject, message.toByteArray))
```

#### Почему короткие пакеты?

- `auction.domain.session` вместо `io.solguficky.auction.domain.session`
- Это внутренний микросервис, не публичная библиотека
- Меньше визуального шума, проще навигация

#### Почему Domain-Driven структура?

```
domain/        ← бизнес-логика (не зависит от gRPC/NATS)
application/   ← координация (use cases)
infrastructure/← технические детали (NATS, PostgreSQL)
```

- Четкое разделение ответственности
- Domain легко тестировать (нет зависимостей от транспорта)
- Application — тонкая обертка над domain
- Infrastructure — детали реализации

### Последствия

#### Позитивные

- ✅ **Типобезопасность на всех уровнях** — компилятор ловит ошибки
- ✅ **Event Sourcing "из коробки"** — не нужно писать с нуля
- ✅ **Тестируемость** — EventSourcedBehaviorTestKit позволяет тестировать без БД
- ✅ **Единая экосистема** — Akka для акторов, gRPC, персистентности
- ✅ **Production-ready** — Akka используется в тысячах продакшн систем
- ✅ **Audit trail** — Event Store содержит полную историю

#### Негативные

- ⚠️ **JVM memory footprint** — требует больше памяти чем Rust/Go (~500MB+ heap)
- ⚠️ **Время компиляции** — Scala компилируется медленнее (first build ~2-3 мин)
- ⚠️ **Learning curve** — нужно знать Akka, Event Sourcing, Scala
- ⚠️ **JVM startup time** — ~5-10 сек (vs ~1 сек у Rust)

#### Компромиссы

| Метрика | Scala + Akka | Rust + Actix |
|---------|--------------|--------------|
| Time to market | ✅ Быстрее (готовый Event Sourcing) | ⚠️ Медленнее (писать с нуля) |
| Memory usage | ⚠️ 500MB+ | ✅ 50MB |
| Startup time | ⚠️ 5-10 сек | ✅ 1 сек |
| Type safety | ✅ Отличная | ⚠️ Средняя (акторы не типобезопасны) |
| Event Sourcing | ✅ Production-ready | ⚠️ Нужно писать |
| Тестируемость | ✅ TestKit из коробки | ⚠️ Сложнее |

**Вывод:** Для stateful сервиса с Event Sourcing выигрыш в time to market и надежности важнее экономии памяти.

### Альтернативные решения и почему они не выбраны

**F# + Akka.NET:**
- Отличный выбор, но Akka.NET менее зрелый чем Akka JVM
- Меньше примеров Event Sourcing в production
- Community меньше

**Rust + custom Event Sourcing:**
- Пришлось бы писать Event Store, снапшоты, recovery с нуля
- Time to market намного больше
- Риск багов в критической части

**Kotlin + Ktor + Event Sourcing библиотека:**
- Нет готового Event Sourcing фреймворка уровня Akka Persistence
- Пришлось бы выбирать из менее зрелых решений

### Связанные решения

- **ADR-001:** Микросервисная архитектура с хореографией
- **ADR-002:** CQRS и Event Sourcing для stateful-сервисов
- **ADR-007:** Полиглотная модель (каждый язык под свою задачу)
- **ADR-009:** Иерархия акторов (AuctionSession → Lot)

---

### Обновление ADR-017: Миграция на C# + Akka.NET

**Дата обновления**: 24.10.2025

**Статус**: Пересмотрено → **Принято решение о миграции на C# + Akka.NET**

### Причины пересмотра

В процессе setup окружения для Scala 3 + Akka Typed возникли значительные технические препятствия:

1. **Сложности с Coursier/Metals:**
   - AccessDenied ошибки при загрузке Scala toolchain
   - Проблемы с SSL/revocation checks в корпоративной среде Windows
   - Нестабильная работа Metals LSP

2. **Setup окружения:**
   - sbt + Coursier + Metals требуют сложной настройки на Windows
   - Множество движущихся частей (JVM toolchain, sbt launchers, LSP servers)
   - Долгое время первой компиляции (2-3 минуты)

3. **Pragmatic choice:**
   - Time to market важнее теоретической чистоты
   - .NET окружение уже знакомо и стабильно
   - Одна команда `dotnet new` vs десятки шагов настройки Scala

### Новое решение: C# + Akka.NET

**Технологический стек:**

| Компонент | C# + Akka.NET |
|-----------|---------------|
| **Язык** | C# 12 (.NET 8/9) |
| **Фреймворк** | Akka.NET 1.5.x (classic API) |
| **Event Sourcing** | Akka.Persistence.PostgreSql |
| **База данных** | PostgreSQL (Event Store) |
| **gRPC** | Grpc.AspNetCore + Google.Protobuf |
| **NATS** | NATS.Client (официальный .NET клиент) |
| **Тестирование** | xUnit + Akka.TestKit.Xunit2 |
| **Логирование** | Serilog с JSON форматом |

### Сравнение Scala/Akka vs C#/Akka.NET

| Критерий | Scala + Akka Typed | C# + Akka.NET Classic | Победитель |
|----------|-------------------|----------------------|------------|
| **Setup окружения** | Сложный (sbt, Metals, Coursier) | Простой (dotnet CLI) | ✅ C# |
| **Time to first compile** | 2-3 минуты | 30 секунд | ✅ C# |
| **IDE поддержка** | Metals (нестабилен) | OmniSharp/Roslyn (стабилен) | ✅ C# |
| **Типобезопасность** | Отличная (ADTs, sealed traits) | Хорошая (record types, sealed classes) | 🟡 Scala |
| **Event Sourcing зрелость** | Akka Persistence Typed (новый) | Akka.Persistence (зрелый) | ✅ C# |
| **gRPC интеграция** | akka-grpc (специфичный) | Grpc.AspNetCore (стандарт .NET) | ✅ C# |
| **Community & примеры** | Меньше для Typed API | Больше для Classic API | ✅ C# |
| **Найм разработчиков** | Сложнее | Проще | ✅ C# |
| **Immutability by default** | Да (case class) | Нет (но есть record) | 🟡 Scala |
| **Pattern matching** | Native, exhaustive | Switch expressions | 🟡 Scala |

### Что сохраняется

Архитектурные решения остаются прежними:

✅ **Domain-Driven Design** — domain/, application/, infrastructure/
✅ **Event Sourcing** — события как source of truth
✅ **Акторная модель** — изоляция состояния, hierarchy
✅ **Иерархия акторов** — AuctionRegistry → AuctionSession → Lot
✅ **Protobuf контракты** — остаются без изменений
✅ **NATS integration** — те же команды и события
✅ **PostgreSQL Event Store** — та же схема БД

### Что меняется

**Синтаксис и API:**

**Scala:**
```scala
sealed trait Command
final case class PlaceBid(userId: Long, amount: Double, replyTo: ActorRef[Response]) extends Command

object Lot:
  def apply(lotId: Int): Behavior[Command] =
    EventSourcedBehavior[Command, Event, State](...)
```

**C#:**
```csharp
public abstract record Command;
public sealed record PlaceBid(long UserId, double Amount, IActorRef ReplyTo) : Command;

public class LotActor : ReceivePersistentActor
{
    public LotActor(int lotId) { ... }
}
```

**Akka API:**
- Scala: `EventSourcedBehavior` (Typed API)
- C#: `ReceivePersistentActor` (Classic API)

**Build system:**
- Scala: sbt
- C#: dotnet CLI

**IDE:**
- Scala: Metals LSP
- C#: OmniSharp/Roslyn

### Обоснование миграции

#### Почему C# + Akka.NET лучше для нас сейчас?

1. **Pragmatic choice для MVP:**
   - Нужно быстро валидировать бизнес-логику
   - Setup проблемы Scala блокируют разработку
   - .NET окружение уже работает

2. **Akka.NET достаточно зрелый:**
   - Classic API стабилен и production-ready
   - Akka.Persistence.PostgreSql используется в продакшене
   - Большое community, много примеров

3. **Проще онбординг:**
   - C# знают больше разработчиков
   - .NET tooling стабильнее на Windows
   - Меньше "магии" в build system

4. **Grpc.AspNetCore — стандарт:**
   - Официальная поддержка от Microsoft
   - Отличная интеграция с ASP.NET Core
   - Привычный для .NET разработчиков

#### Компромиссы

**Теряем:**
- ⚠️ Exhaustive pattern matching (но есть switch expressions с warnings)
- ⚠️ Immutability by default (но есть record types)
- ⚠️ Typed actors API (но Classic API стабильнее)

**Получаем:**
- ✅ Быстрый старт (dotnet new)
- ✅ Стабильный tooling (OmniSharp)
- ✅ Больше примеров и community support
- ✅ Проще найм и онбординг

### Последствия

#### Позитивные

- ✅ **Быстрый старт** — `dotnet new webapi` и готово
- ✅ **Стабильное окружение** — нет проблем с Metals/Coursier
- ✅ **Знакомый стек** — .NET, C#, ASP.NET Core
- ✅ **Akka.NET зрелый** — Classic API production-ready
- ✅ **Event Sourcing работает** — Akka.Persistence.PostgreSql стабилен
- ✅ **gRPC "из коробки"** — Grpc.AspNetCore стандарт
- ✅ **Легче онбординг** — C# популярнее Scala

#### Негативные

- ⚠️ **Менее строгая типизация** — нет exhaustive checking (но есть nullable reference types)
- ⚠️ **Mutable by default** — нужна дисциплина (но есть record types)
- ⚠️ **Classic API** — менее элегантный чем Typed (но стабильнее)
- ⚠️ **Больше boilerplate** — C# многословнее Scala

#### Миграция в будущем

Если потребуется вернуться к Scala/Akka:
- Архитектура (DDD, Event Sourcing, actors) не изменится
- Protobuf контракты останутся теми же
- PostgreSQL Event Store совместим
- Миграция возможна без изменения других сервисов

### Итоговое решение

**Используем C# + Akka.NET Classic для Auction Service** с сохранением:
- Domain-Driven Design структуры
- Event Sourcing через Akka.Persistence
- Акторной иерархии (Registry → Session → Lot)
- Protobuf контрактов для gRPC и NATS
- PostgreSQL как Event Store

**Причина:** Pragmatic choice — быстрый старт важнее теоретической чистоты. Akka.NET достаточно зрелый для production, setup простой, community большой.

---
