# Identity

gRPC-сервис разрешения Telegram-личности во внутренний идентификатор. Схема профилей и глобальных ролей применяется миграциями PostgreSQL при старте. `ResolveIdentity` создаёт профиль при первом обращении и возвращает внутренний идентификатор с активными общими ролями.

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

В составе локальной топологии профиль `core` или `full` запускает Identity через AppHost, предварительно выполняет ту же Protobuf-кодогенерацию и передаёт динамический gRPC-порт и PostgreSQL URI:

```bash
just aspire core
```

Фактический endpoint при таком запуске смотри в Aspire dashboard или `aspire describe`; фиксированный `localhost:50051` относится только к ручному `just identity-run` без переопределения адреса.

По умолчанию сервис слушает `:50051`. Адрес задаётся `IDENTITY_GRPC_ADDR`, строка подключения к PostgreSQL — `IDENTITY_DATABASE_URL` (обязательна), уровень лога — `IDENTITY_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`). При старте процесс применяет миграции из `internal/migrations/` и только потом начинает слушать. Пул `database/sql` ограничен 16 открытыми соединениями, время жизни соединения — 30 минут. Успешный RPC пишется на `Debug`, поэтому журнал доступа включает `IDENTITY_LOG_LEVEL=debug`.

Интеграционные тесты схемы и разрешения поднимают изолированную базу на том же PostgreSQL. Если `IDENTITY_DATABASE_URL` не задан, они пробуют `postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable`; без доступной базы локальный прогон пропускает их, а в CI отсутствие базы — ошибка.

`just identity-tools` ставит buf, плагины кодогенерации и golangci-lint закреплённых в `justfile` версий; без него `just verify` падает на линте.

## Проверка

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"telegram_user_id": 1}' \
  localhost:50051 identity.v1.IdentityService/ResolveIdentity
```

Повторный вызов с тем же `telegram_user_id` возвращает тот же `identity_id`. Reflection включена, чтобы `grpcurl` работал без локальных `.proto`.
