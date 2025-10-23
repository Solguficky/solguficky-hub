# Telegram Gateway

API Gateway для платформы Solguficky. Единственная точка входа для всех внешних запросов от Telegram.

## Технологический стек

- **Rust** - основной язык
- **Teloxide** - Telegram Bot Framework (long polling)
- **Axum** - веб-фреймворк для webhooks
- **Tokio** - асинхронный рантайм
- **NATS** - асинхронная шина сообщений. Схемы хранятся в `../../contracts/proto`.
- **Protobuf** - сериализация сообщений. Схемы хранятся в `../../contracts/proto`.
- **dptree** - роутинг запросов
- **tracing** - структурированное логирование

## Архитектурные решения

### Гибридная модель взаимодействия

1. **Команды (Commands)** → NATS (fire-and-forget)
   - Все операции, изменяющие состояние (создание ставки, начало аукциона)
   - Публикация в NATS JetStream с уникальным `op_id`

2. **Запросы (Queries)** → gRPC (синхронно)
   - Все операции чтения данных для отображения UI
   - Прямые вызовы к сервисам (Auction, Events, Users)

3. **События (Events)** ← NATS (подписка)
   - Получение событий от других сервисов
   - Отправка уведомлений пользователям

### Ключевые особенности

- ✅ **Идемпотентность**: Дедупликация callback_query по ID с TTL 1 час
- ✅ **FSM**: Управление диалогами через teloxide::dialogue
- ✅ **Graceful Shutdown**: Корректное завершение при SIGINT/SIGTERM
- ✅ **Структурированное логирование**: tracing spans с контекстом (user_id, chat_id)
- ✅ **Обработка ошибок**: anyhow для app-слоя, thiserror для библиотек

## Структура проекта

```
src/
├── app/              # Application layer
│   ├── commands.rs   # Telegram bot commands
│   ├── deps.rs       # Dependency injection
│   ├── handlers/     # Request handlers
│   ├── state.rs      # FSM states
│   ├── idempotency.rs # Deduplication cache
│   └── event_listener.rs # NATS event subscribers
├── domain/           # Domain types
│   ├── commands.rs   # Commands (PlaceBidCommand)
│   ├── events.rs     # Events (BidPlacedEvent)
│   └── dto.rs        # Data Transfer Objects
├── infra/            # Infrastructure
│   ├── nats_client.rs # NATS client
│   └── mock_auction_service.rs # Mock gRPC client
├── config.rs         # Configuration management
└── lib.rs            # Main entry point
```

## Конфигурация

Конфигурация загружается через `figment`:
1. Базовые значения из `configuration.yaml`
2. Переопределение через переменные окружения с префиксом `APP_`

### Переменные окружения

```bash
# Обязательные
APP_TELEGRAM__TOKEN=your_bot_token_here
APP_NATS__URL=nats://localhost:4222

# Опциональные (есть дефолты)
RUST_LOG=info,telegram_gateway=debug
```

## Запуск

### 🚀 Быстрый старт (Docker)

Полная инструкция по локальному запуску с Docker находится в **[LOCAL_SETUP.md](./LOCAL_SETUP.md)**.

Краткая версия:

```bash
# 1. Создать .env из примера и заполнить токен
cp .env.example .env

# 2. Запустить все сервисы
docker-compose up --build

# 3. Проверить логи
docker-compose logs -f telegram-gateway
```

### Development (без Docker)

```bash
# Установить зависимости
cargo build

# Запустить только инфраструктуру
docker-compose up -d nats apicurio-registry postgres

# Запустить бот локально
RUST_LOG=debug \
APP_TELEGRAM__TOKEN=your_token \
APP_NATS__URL=nats://localhost:4222 \
cargo run
```

### Production

```bash
# Собрать релизную версию
cargo build --release

# Запустить
./target/release/telegram-gateway
```

## Реализация Protobuf

### Текущий статус

✅ **Полностью интегрирован Protobuf для NATS сообщений:**
- Кодогенерация через `prost-build` в `build.rs`
- Схемы хранятся в `../../contracts/proto/`
- `schema-id` передается через NATS headers для версионирования
- Декодирование событий с проверкой `schema-id`

### Примеры кода

**Публикация команды:**
```rust
let proto_cmd = generated::nats::commands::PlaceBidCommand {
    op_id: command.op_id.to_string(),
    event_id: command.event_id,
    lot_id: command.lot_id,
    user_id: command.user_id,
    amount: command.amount,
};

let mut buf = Vec::new();
proto_cmd.encode(&mut buf)?;

let mut headers = async_nats::HeaderMap::new();
headers.insert("content-type", "application/x-protobuf");
headers.insert("schema-id", "place-bid-command-v1");

client.publish_with_headers("commands.auction.place-bid".to_string(), headers, buf.into()).await?;
```

**Декодирование события:**
```rust
let schema_id = message.headers
    .as_ref()
    .and_then(|h| h.get("schema-id"))
    .map(|v| v.as_str());

if schema_id != Some("bid-placed-event-v1") {
    warn!("Unknown schema-id: {:?}", schema_id);
}

let event = generated::nats::events::BidPlacedEvent::decode(&*message.payload)?;
```

## Текущее состояние

### ✅ Реализовано

1. ✅ Базовая структура Dispatcher с dptree
2. ✅ Хендлеры главного экрана (/start → "Ближайший аукцион")
3. ✅ Хендлеры аукциона (список лотов, детали, описание с фото)
4. ✅ FSM для индивидуальной ставки
5. ✅ Публикация команд PlaceBid в NATS (Protobuf)
6. ✅ Подписка на события из NATS (Protobuf)
7. ✅ Отправка уведомлений в Telegram
8. ✅ Graceful shutdown
9. ✅ Структурированное логирование (tracing spans)
10. ✅ Идемпотентность (дедупликация callback_query.id)
11. ✅ Protobuf сериализация с кодогенерацией
12. ✅ Просмотр своих ставок ("📊 Мои ставки")
13. ✅ Информация об аукционе ("❓ Как это работает?")
14. ✅ Обработка неизвестных сообщений
15. ✅ Улучшенная навигация после ставок
16. ✅ Отображение всех лотов (убрано ограничение на 5)
17. ✅ История ставок для каждого лота

### 🚧 Планируется

1. Замена моков на реальные gRPC-клиенты
2. Интеграция с Apicurio Registry для автоматической регистрации схем
3. Метрики Prometheus (/metrics endpoint)
4. Health checks (/health endpoint)
5. Webhook mode (вместо long polling)
6. Персистентное хранилище для idempotency cache (Redis)

## Тестирование

```bash
# Unit tests
cargo test

# Linter
cargo clippy -- -D warnings

# Format check
cargo fmt -- --check
```

## Примеры использования

### Навигационный flow

```
/start
  → Главный экран с кнопками:
    • "🎪 Аукционы" → Список лотов
    • "📊 Мои ставки" → История ставок пользователя с отображением статуса (лидирует / перебито)
    • "❓ Как это работает?" → Информация об аукционе с инструкциями

  → "🎪 Аукционы" → Список всех лотов (без ограничений)
    → Детали лота
      → "📖 Посмотреть описание" → Фото + описание + кнопки действий
      → "🎯 Начать торги за X руб" → Публикация PlaceBidCommand в NATS
      → "💰 Повысить на X руб" → Публикация PlaceBidCommand в NATS
      → "✏️ Индивидуальная ставка" → FSM: ожидание ввода → Публикация PlaceBidCommand
      → После ставки: кнопки "◀️ К лотам" и "↩️ В главное меню"
```

### Пример команды в NATS

```protobuf
message PlaceBidCommand {
  string op_id = 1;           // UUID для идемпотентности
  string event_id = 2;        // "summer-meetup-2024"
  uint32 lot_id = 3;          // 1
  int64 user_id = 4;          // 123456789
  double amount = 5;          // 500.0
}
```

Subject: `commands.auction.place-bid`

### Пример события из NATS

```protobuf
message BidPlacedEvent {
  string event_id = 1;        // "summer-meetup-2024"
  uint32 lot_id = 2;          // 1
  int64 user_id = 3;          // 987654321
  double amount = 4;          // 600.0
  int64 previous_leader_id = 5; // 123456789
  int64 current_leader_id = 6; // 987654321
}
```

Subject: `events.auction.bid-placed`

## Документация

- [Архитектура платформы](../../docs/01_ARCHITECTURE/architechture.md)
- [ТЗ на Telegram Gateway](../../docs/02_SERVICES/telegram-gateway.md)
- [Контракты NATS](../../docs/03_CONTRACTS/nats_subjects.md)

## Лицензия

См. [LICENSE](../../LICENSE)

