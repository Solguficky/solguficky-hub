# Telegram Gateway (Rust + Teloxide)

Статус: **Current/Legacy**. Входной шлюз принимает апдейты Telegram, показывает старый аукционный UI, публикует команды в NATS и слушает события. Не расширяй его как целевую реализацию MVP без явного запроса.

Этот файл содержит только service-specific delta. Общие требования к тестированию, контрактам и логированию наследуются из [docs/standards](../../docs/standards/README.md).

## Структура

- `src/app/handlers/` — хендлеры. Возвращают `BotAction` (enum в `actions.rs`), НЕ вызывают Bot API напрямую; исполнение — `helpers::execute_action`.
- `src/app/wrappers.rs` + `macros.rs` — генерация обёрток `wrap_handler!` и роутинг колбэков `callback_routes!` (см. `lib.rs`).
- `src/app/fsm/` — FSM-диалоги (создание лота) как чистые функции: `(state, input) → FsmTransition { new_state, action }`.
- `src/app/ui/` — чистые билдеры UI: `(DTO) → (String, InlineKeyboardMarkup)`; разделены на `user/` и `admin/`.
- `src/app/auth/` — роли (Admin/User) из `configuration.yaml` (`auth.admins`) — временно до Identity Service.
- `src/app/idempotency.rs` — дедупликация callback_query по id (in-memory TTL).
- `src/infra/` — NATS-клиент (Protobuf через prost), `MockAuctionService` (замена реального gRPC — временная).
- `src/generated/` — кодогенерация prost из `contracts/proto` (см. `build.rs`).

## Правила

- Новый хендлер: функция в `handlers/` → `wrap_handler!` в `wrappers.rs` → маршрут в `callback_routes!` в `lib.rs`. Админские маршруты помечай `[admin_only]`.
- FSM и UI — чистые функции, покрывай юнит-тестами (`tests/`).
- Никакого JSON в NATS — только Protobuf из `generated/`.
- Конфиг: `configuration.yaml` + переменные `APP_*` (figment). Токен бота — только через `.env`.

## Запуск

```bash
# Предпочтительно: профиль infra из infra/apphost; compose остаётся fallback
cargo run
cargo test && cargo clippy -- -D warnings
```
