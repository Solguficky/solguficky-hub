# Identity

gRPC-сервис разрешения Telegram-личности во внутренний идентификатор. Схема профилей и глобальных ролей применяется миграциями PostgreSQL при старте. `ResolveIdentity` пока отвечает фиксированной заглушкой: логика допуска появится отдельно.

Сгенерированный контракт лежит в `gen/` и в Git не хранится. Команда сборки сначала вызывает `buf generate`.

## Команды

Из корня репозитория:

```bash
just identity-tools
just identity-proto
just identity-build
just identity-test
just identity-lint
just identity-run
```

По умолчанию сервис слушает `:50051`. Адрес задаётся `IDENTITY_GRPC_ADDR`, строка подключения к PostgreSQL — `IDENTITY_DATABASE_URL` (обязательна), уровень лога — `IDENTITY_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`). При старте процесс применяет миграции из `internal/migrations/` и только потом начинает слушать. Успешный RPC пишется на `Debug`, поэтому журнал доступа включает `IDENTITY_LOG_LEVEL=debug`.

Интеграционные тесты схемы поднимают изолированную базу на том же PostgreSQL. Если `IDENTITY_DATABASE_URL` не задан, они пробуют `postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable`; без доступной базы локальный прогон пропускает их, а в CI отсутствие базы — ошибка.

`just identity-tools` ставит buf, плагины кодогенерации и golangci-lint закреплённых в `justfile` версий; без него `just verify` падает на линте.

## Проверка

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"telegram_user_id": 1}' \
  localhost:50051 identity.v1.IdentityService/ResolveIdentity
```

Заглушка возвращает `identity_id` `0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd` и пустой набор ролей. Reflection включена, чтобы `grpcurl` работал без локальных `.proto`.
