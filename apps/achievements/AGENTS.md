# Achievements

Elixir на OTP. Устройство и границы — [ADR-077](../../docs/decisions/ADR-077-achievements-cross-cutting-service.md) с дополнением 2026-10-26, ответственность — [бриф](../../docs/services/achievements.md), устройство каталога — [README](README.md). Состав полей лога — [standard](../../docs/standards/observability/logging.md), уровни тестов — [standard](../../docs/standards/testing/testing-strategy.md), имена тестов — [standard](../../docs/standards/testing/naming.md).

- Сборка и тесты идут с `--warnings-as-errors`: предупреждение компилятора — красный гейт, а не шум.
- Миграции применяет `Ecto.Migrator` в дереве до gRPC-границы: обработчик рассчитывает на готовую схему и сам её не проверяет. Новая миграция — файл в `priv/repo/migrations/`, она едет в release.
- Конфигурация из среды читается только в `config/runtime.exs`, разбор и отказы — в `Achievements.Settings` и `Achievements.DatabaseUrl`. Отказ называет переменную и не повторяет её значение.
- Запись о вызове пишет только граница: gRPC — `Achievements.Grpc.Boundary`, шина — релей своим тиком. Домен и адаптеры возвращают результат и не логируют; отчёт адаптера grpc о `GRPC.RPCError` выключен фильтром, потому что отказ уже записала граница.
- Тест с базой или шиной — L1: лежит в `test/integration/` с `@moduletag :integration` и поднимает свои контейнеры. Уровень выбирает `ACHIEVEMENTS_INTEGRATION_TESTS=1`, а не пропуск. Добавил или удалил тест — поправь порог своего уровня в `test/test_helper.exs` тем же изменением.
- Версии Erlang/OTP и Elixir меняются в `.tool-versions`, суммах `ERLANG_SHA256`/`ELIXIR_SHA256` в корневом `justfile` и теге базы `Containerfile` одним изменением: сверка в образе роняет сборку на расхождении.
- Команды — `just achievements-*`.
