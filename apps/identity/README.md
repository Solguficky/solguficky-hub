# Identity

gRPC-сервис разрешения Telegram-личности во внутренний идентификатор, служебной выдачи глобальной роли администратора и синхронной проверки глобальной роли для соседних сервисов. Схема профилей и глобальных ролей применяется миграциями PostgreSQL при старте. `ResolveIdentity` создаёт профиль при первом обращении и возвращает внутренний идентификатор, активные общие роли и отметку блокировки отдельным полем.

Сгенерированный контракт лежит в `gen/` и в Git не хранится. Команда сборки сначала вызывает `buf generate`.

## Команды

Из корня репозитория:

```bash
just identity-tools
just identity-proto
just identity-build
just identity-test
just identity-test-integration
just identity-lint
just identity-run
```

В составе локальной топологии профиль `hub` запускает Identity через AppHost: отдельные ресурсы выполняют ту же Protobuf-кодогенерацию и `go build` в `bin/` (в Git тоже не хранится), после чего AppHost запускает собранный бинарник с динамическим gRPC-портом и PostgreSQL URI:

```bash
dotnet user-secrets --project infra/apphost set Parameters:identity-maintainer-token "<secret>"
just aspire hub
```

Фактический endpoint при таком запуске смотри в Aspire dashboard или `aspire describe`; фиксированный `localhost:50051` относится только к ручному `just identity-run` без переопределения адреса.

По умолчанию сервис слушает `:50051`. Адрес задаётся `IDENTITY_GRPC_ADDR`, строка подключения к PostgreSQL — `IDENTITY_DATABASE_URL` (обязательна), секрет служебных RPC — `IDENTITY_MAINTAINER_TOKEN` (пустое или отсутствующее значение закрывает методы), уровень лога — `IDENTITY_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`). При старте процесс применяет миграции из `internal/migrations/` и только потом начинает слушать. Пул `database/sql` ограничен 16 открытыми соединениями, время жизни соединения — 30 минут. Успешный RPC пишется на `Info`, как у Meetups и бота; успешная проба `grpc.health.v1` остаётся на `Debug`, потому что идёт каждые несколько секунд. Успешные maintainer-вызовы дополнительно пишут на `Info` запись о выдаче или снятии роли с `identity_id` цели и без значения секрета. При заданном `OTEL_EXPORTER_OTLP_ENDPOINT` (его выставляет AppHost) те же записи уходят ещё и по OTLP в Structured logs dashboard, с тем же порогом `IDENTITY_LOG_LEVEL`; stdout остаётся.

Адрес NATS для релея outbox — `IDENTITY_NATS_URL`. Без него релей не запускается: сервис работает, а события копятся в таблице `identity_outbox` и уйдут, когда адрес появится. С адресом процесс раз в секунду публикует очередь в стрим `IDENTITY_EVENTS`; устройство и поля лога тика — [бриф](../../docs/services/identity.md#outbox-и-релей).

Интеграционные тесты схемы и разрешения лежат в `*_integration_test.go` под тегом сборки `integration` и идут рецептом `just identity-test-integration`; `just identity-test` гоняет только unit-файлы и базы не требует. Интеграционные тесты поднимают изолированную базу на PostgreSQL из `IDENTITY_DATABASE_URL`. Умолчания у адреса нет: прежнее `127.0.0.1:5432` отдавало вердикт тому, что слушает общий порт машины, и посторонний PostgreSQL с другим паролем ронял гейт. Без переменной `just identity-test-integration` отказывает до `go test` и называет это отказом среды; локально подойдёт одноразовый контейнер, например `docker run -d --rm -p 55439:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine` и `IDENTITY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres?sslmode=disable` — порт выбирай свободный, соседние сессии занимают свои. Без доступной базы прогон падает и локально, и в CI. Пропуска `internal/testdb` не даёт намеренно: зелёный прогон на пропущенных тестах неотличим от проверки ([PER-241](https://linear.app/anticnvm/issue/per-241)). Тесты релея поднимают встроенный `nats-server` в процессе теста, поэтому ни Docker, ни внешний NATS им не нужны. Фикстуры с состоянием мимо сервиса выключают триггеры схемы в своей транзакции через `session_replication_role`, поэтому пользователь из `IDENTITY_DATABASE_URL` должен быть суперпользователем — `postgres` одноразового контейнера и CI им и открываются.

`just identity-tools` ставит buf, плагины кодогенерации и golangci-lint закреплённых в `justfile` версий; без него `just verify` падает на линте.

## Проверка

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"telegram_user_id": 1}' \
  localhost:50051 identity.v1.IdentityService/ResolveIdentity
```

Повторный вызов с тем же `telegram_user_id` возвращает тот же `identity_id`. Reflection включена, чтобы `grpcurl` работал без локальных `.proto`.

Сначала зарегистрируйте профиль через `ResolveIdentity`, затем используйте возвращённый `identity_id`:

```bash
export IDENTITY_MAINTAINER_TOKEN='<secret>'
grpcurl -plaintext -H "authorization: Bearer ${IDENTITY_MAINTAINER_TOKEN}" \
  -d '{"identity_id":"<identity-id>"}' \
  localhost:50051 identity.v1.IdentityService/GrantAdminRole
grpcurl -plaintext -H "authorization: Bearer ${IDENTITY_MAINTAINER_TOKEN}" \
  -d '{"identity_id":"<identity-id>"}' \
  localhost:50051 identity.v1.IdentityService/RevokeAdminRole
```

Повтор операции успешен с `changed: false`. Выдача заблокированному профилю отвечает `FAILED_PRECONDITION`, отличимо от `NOT_FOUND` для отсутствующего профиля; каждое изменение ложится в журнал доступа в той же транзакции. Не передавайте секрет параметром `-vv` и не печатайте его в журнал.

Проверка глобальной роли секрета не требует: вызывающий называет роли, которые принимает, и получает `granted`. Ответ читается из текущего состояния, так что после `RevokeAdminRole` тот же вызов сразу отвечает `false`:

```bash
grpcurl -plaintext \
  -d '{"identity_id":"<identity-id>","accepted_roles":["GLOBAL_ROLE_ADMIN"]}' \
  localhost:50051 identity.v1.IdentityService/CheckGlobalRole
```
