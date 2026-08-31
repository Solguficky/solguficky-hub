# Identity

gRPC-сервис разрешения Telegram-личности во внутренний идентификатор. Сейчас это скелет: `ResolveIdentity` отвечает фиксированной заглушкой, схемы и логики допуска ещё нет.

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

По умолчанию сервис слушает `:50051`. Адрес задаётся `IDENTITY_GRPC_ADDR`, уровень лога — `IDENTITY_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`). Успешный RPC пишется на `Debug`, поэтому журнал доступа включает `IDENTITY_LOG_LEVEL=debug`.

`just identity-tools` ставит buf, плагины кодогенерации и golangci-lint закреплённых в `justfile` версий; без него `just verify` падает на линте.

## Проверка

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"telegram_user_id": 1}' \
  localhost:50051 identity.v1.IdentityService/ResolveIdentity
```

Заглушка возвращает `identity_id` `0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd` и пустой набор ролей. Reflection включена, чтобы `grpcurl` работал без локальных `.proto`.
