# Achievements

Сквозной сервис ачивок на Elixir (OTP): устройство и границы — [ADR-077](../../docs/decisions/ADR-077-achievements-cross-cutting-service.md) с дополнением 2026-10-26, ответственность — [бриф](../../docs/services/achievements.md). Сейчас это скелет: база, health и релей outbox. Правила, определения, акторы ачивок и контракт приносят соседние задачи.

## Устройство

- `lib/achievements/application.ex` — дерево процесса: Repo, миграции Ecto до listen, соединение с NATS и релей outbox (только с адресом шины), `DynamicSupervisor` `Achievements.Actors` под акторы ачивок и последним gRPC-граница.
- `lib/achievements/health/` — `grpc.health.v1.Health/Check`: пустое имя — liveness без базы, `achievements.v1.AchievementsService` — readiness с базой. Сообщения health записаны DSL библиотеки `protobuf`: схема чужая и неизменная, а кодогенерацию из `contracts/proto` приносит контракт сервиса.
- `lib/achievements/grpc/boundary.ex` — интерцептор границы: спан и одна запись каркаса лога на вызов по [стандарту логирования](../../docs/standards/observability/logging.md).
- `lib/achievements/relay.ex` — релей outbox в JetStream по порядку `position` с `Nats-Msg-Id` = `event_id`; отказ шины останавливает пачку на первой неподтверждённой строке.
- `lib/achievements/telemetry.ex` — поле `service` в каждой записи и экспорт логов по OTLP, когда среда дала `OTEL_EXPORTER_OTLP_ENDPOINT`; трейсы включает `config/runtime.exs`.
- `priv/repo/migrations/` — схема; `config/runtime.exs` — конфигурация из среды.

## Переменные окружения

| Переменная | Обязательна | Что |
|---|---|---|
| `ACHIEVEMENTS_DATABASE_URL` | да | URI PostgreSQL в форме libpq; `sslmode` переводится в опции TLS, другие параметры строки отвергаются |
| `ACHIEVEMENTS_GRPC_PORT` | нет, `50051` | порт gRPC-границы (h2c) |
| `ACHIEVEMENTS_NATS_URL` | нет | `nats://[user:password@]host:port`; без него релей не стартует, строки ждут в outbox |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME` | нет | экспорт логов и трейсов; без адреса экспорт выключен |

## Команды

`just achievements-*`: `-tools` ставит Hex, rebar и зависимости по `mix.lock`, `-build` и `-test` идут с `--warnings-as-errors`, `-test-integration` — L1 на Testcontainers (нужен Docker), `-format-check`, `-run`, `-image`. Версии Erlang/OTP и Elixir — `.tool-versions`; на Linux их ставит `tools/env/install.sh`.

Уровень тестов выбирает переменная `ACHIEVEMENTS_INTEGRATION_TESTS=1`, а не пропуск: `test/test_helper.exs` исключает тег `:integration` на L0 и роняет прогон на пропущенном тесте и на недоборе до порога уровня. Добавил или удалил тест — поправь порог тем же изменением.

Образ запускает release в interactive-режиме (`RELEASE_MODE=interactive`): модули грузятся по первому вызову, и узел без нагрузки держит около 60 МиБ против 140 в embedded.
