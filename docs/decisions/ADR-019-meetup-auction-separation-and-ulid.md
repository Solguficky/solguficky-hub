# ADR-019: Разделение Meetup и Auction, формат ID - ULID

**Дата**: 30.10.2025

**Статус**: Частично заменено ADR-020 (формат ID: ULID → UUIDv7). Разделение концепций Meetup/Auction остаётся в силе.

#### Контекст

Изначально `meetup_id` использовался как идентификатор аукциона, что создавало путаницу между концепциями Meetup (событие/сходка) и Auction (процесс торгов).

**Проблемы:**
- Смешение понятий Meetup и Auction
- Неясно, какой ID использовать для команд аукциона
- Сложность при будущем расширении (несколько аукционов на один meetup)

#### Решение

**1. Разделить концепции:**
- **Meetup** - событие/сходка (future scope, пока нет сервиса)
- **Auction** - процесс торгов (текущий scope)

**2. Формат ID - ULID:**
- ULID (Universally Unique Lexicographically Sortable Identifier)
- 128-bit, формат: `01H2XCEJQTF2NBREXX3VQJHP41` (26 символов, Base32)
- Первые 48 бит = timestamp (мс), остальные 80 бит = random
- Сортируется по времени создания
- Безопасно для distributed генерации

**3. Генерация ID:**
- **telegram-gateway** генерирует ULID локально (без round-trip к сервису)
- Для MVP один захардкоженный `AUCTION_ID` в константе
- При добавлении создания аукционов - генерация через библиотеку (Rust: `ulid-rs`, C#: `Ulid.NewUlid()`)

**4. Persistence ID:**
```csharp
// AuctionActor
PersistenceId = $"auction-{auctionId}"

// LotActor остается
PersistenceId = $"lot-{lotId}"
```

**5. БД структура:**
```sql
-- lots table
auction_id VARCHAR(26) NOT NULL  -- ULID format
lot_id INT PRIMARY KEY
```

#### Почему ULID, а не GUID или INT?

| Критерий | INT | GUID v4 | ULID |
|----------|-----|---------|------|
| **Генерация** | Нужен round-trip к БД | Локально | Локально |
| **Сортировка** | ✅ По порядку | ❌ Случайный | ✅ По времени |
| **Индексы PostgreSQL** | ✅ Компактно | ⚠️ Фрагментация | ✅ Упорядочены |
| **Distributed safe** | ❌ Коллизии | ✅ Безопасно | ✅ Безопасно |
| **Читаемость** | ✅ | ⚠️ Длинный | ✅ Компактный |

#### Обоснование

1. **Семантическая ясность:**
   - `auction_id` - четко указывает на аукцион
   - `meetup_id` - можно использовать в будущем как foreign key
   - Разделение ответственности (Meetup Service ≠ Auction Service)

2. **ULID преимущества:**
   - Локальная генерация = нет дополнительного latency
   - Сортировка по времени = удобство для запросов
   - Distributed-safe = можно генерировать в любом сервисе
   - Idempotency = повторная отправка с тем же ID не создаст дубликат

3. **Event Sourcing friendly:**
   - Aggregate ID известен до команды
   - Можно создать actor на лету
   - Нет race condition при создании

#### Последствия

**Позитивные:**
- ✅ Четкое разделение концепций Meetup vs Auction
- ✅ ULID дает все преимущества GUID + сортировка
- ✅ Локальная генерация = нет round-trip
- ✅ Idempotency из коробки
- ✅ Гибкость для будущего расширения (N аукционов на meetup)

**Негативные:**
- ⚠️ Breaking change для контрактов (все сервисы обновляются разом)
- ⚠️ String ID = немного больше памяти чем INT (26 байт vs 4 байта)

**Миграционный путь:**
- Для MVP: пересоздать БД (данных нет)
- Для prod: добавить колонку `auction_id`, заполнить через скрипт, удалить `meetup_id`

#### Примеры

**Генерация ULID в Rust:**
```rust
use ulid::Ulid;
let auction_id = Ulid::new().to_string(); // "01JBEX..."
```

**Генерация ULID в C#:**
```csharp
using Ulid;
var auctionId = Ulid.NewUlid().ToString(); // "01JBEX..."
```

**Protobuf контракт:**
```protobuf
message StartAuctionCommand {
  string auction_id = 2;  // ULID format
}
```

#### Связанные решения

- **ADR-002**: Event Sourcing для stateful-сервисов
- **ADR-005**: gRPC для синхронного взаимодействия
- **ADR-009**: Иерархия акторов (AuctionActor → LotActor)

---
