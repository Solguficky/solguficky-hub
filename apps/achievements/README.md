# Achievements

Сквозной сервис ачивок на Elixir (OTP): устройство и границы — [ADR-077](../../docs/decisions/ADR-077-achievements-cross-cutting-service.md) с дополнением 2026-10-26, ответственность — [бриф](../../docs/services/achievements.md). Сервис держит определения ачивок кодом, читает факты `AUCTION_EVENTS` актором на ачивку, ведёт реестр выдач, публикует факт выдачи через outbox и отдаёт ботам коллекцию, набор события и картинку по gRPC ([PER-752](https://linear.app/anticnvm/issue/per-752)). Ручная выдача — [PER-753](https://linear.app/anticnvm/issue/per-753), стирание — [PER-755](https://linear.app/anticnvm/issue/per-755), ачивки поставки — [PER-575](https://linear.app/anticnvm/issue/per-575) и [PER-576](https://linear.app/anticnvm/issue/per-576).

## Устройство

- `lib/achievements/application.ex` — дерево процесса: Repo, миграции Ecto до listen, метрики, соединение с NATS и релей outbox (только с адресом шины), супервизор акторов `Achievements.Actors` и последним gRPC-граница.
- `lib/achievements/definitions.ex`, `definition.ex`, `rule.ex` — определения поставки, форма определения и поведение правила. Новая ачивка — определение в `Definitions`, модуль `Achievements.Rule` рядом, если у неё правило, её строка в `images/badges.json` и PNG, который собирает `just achievements-images`. В поставке — первый набор аукциона из шести ачивок ([набор](../../docs/product/future/achievements-auction.md), [PER-576](https://linear.app/anticnvm/issue/per-576)) с датой начала 7 ноября 2026 года: аукцион 2026 он сам не пересчитывает.
- `lib/achievements/rules/` — правила первого набора. `settlement.ex` — общий барьер ачивок за ход торгов: продажа, оплата своим победителем и конец аукциона в любом порядке, только если правило видело начало торгов — `prebidding_started`, а у аукциона без онлайн-этапа `final_started`; лот выдаёт ачивку на последнем из фактов, лот с выдачей больше не пересчитывается, а лот без неё пересчитывает каждый следующий его факт. Состояние лежит по ключам `auction:<id>`, `lot:<id>` и `buyer:<аукцион>:<покупатель>`; конец аукциона и начало торгов грузят лоты реестра из `lot_ids` снимка.
- `images/` — node-единица картинок: SVG-шаблон `template.ts` (рамка по ценности, знак, подпись охвата), `badges.json` (ценность, охват и знак на код) и `render.ts`, который пишет PNG в `priv/achievements/` resvg в wasm со шрифтом DejaVu Sans из `package-lock.json`. PNG лежат в Git, образ их не пересобирает; `just achievements-images-check` сверяет их с шаблоном побайтно, а L0 — `badges.json` с определениями.
- `lib/achievements/catalog.ex` — проверка определений и загрузка картинок при старте; версия картинки — первые 16 знаков sha256 её байтов.
- `lib/achievements/actors.ex` — загрузка каталога, сверка с кодами зафиксированных наборов в базе и по актору на ачивку с правилом: рестарт супервизора поднимает всех заново.
- `lib/achievements/actor.ex` — актор ачивки: эфемерный потребитель JetStream с позиции из базы + 1 или с даты начала ачивки, выборка по одному своей подпиской на inbox, подтверждение после commit.
- `lib/achievements/auction_facts.ex` — разбор фактов Auction по subject в доменные факты `Achievements.Fact`; каждый повод контракта отображён или явно пропущен.
- `lib/achievements/ledger.ex` — одна транзакция на факт: позиция, дедупликация по `event_id`, набор события, состояние правила, выдачи и строки outbox; гашение и его снятие.
- `lib/achievements/reads.ex`, `server.ex`, `proto.ex` — чтения реестра, сервер `achievements.v1.AchievementsService` и отображение в сообщения контракта.
- `lib/achievements/grpc/` — граница: интерцептор записи `boundary.ex` и проверка вызывающего по токену `callers.ex` (ADR-056).
- `lib/achievements/maintenance.ex` — гашение ошибочной выдачи мейнтейнером через `bin/achievements rpc`.
- `lib/achievements/metrics.ex` — `solguficky.failures` и отставание актора от стрима по OTLP.
- `lib/achievements/telemetry.ex` — поле `service` в каждой записи и экспорт логов по OTLP, когда среда дала `OTEL_EXPORTER_OTLP_ENDPOINT`; трейсы и метрики включает `config/runtime.exs`.
- `lib/achievements/health/` — `grpc.health.v1.Health/Check`: пустое имя — liveness без базы, `achievements.v1.AchievementsService` — readiness с базой. Схема health чужая и в `contracts/proto` не лежит, поэтому записана DSL библиотеки `protobuf` руками.
- `lib/achievements/relay.ex` — релей outbox в JetStream по порядку `position` с `Nats-Msg-Id` = `event_id`; отказ шины останавливает пачку на первой неподтверждённой строке.
- `lib/generated/` — модули `achievements.v1` и фактов `auction.v1`, которые пишет `buf generate` по `buf.gen.yaml`; в Git их нет.
- `priv/repo/migrations/` — схема; `config/runtime.exs` — конфигурация из среды.

## Переменные окружения

| Переменная | Обязательна | Что |
|---|---|---|
| `ACHIEVEMENTS_DATABASE_URL` | да | URI PostgreSQL в форме libpq; `sslmode` переводится в опции TLS, другие параметры строки отвергаются |
| `ACHIEVEMENTS_CALLER_TOKEN_HUB_BOT`, `ACHIEVEMENTS_CALLER_TOKEN_AUCTION_BOT` | да | токены вызывающих gRPC ([ADR-056](../../docs/decisions/ADR-056-service-calls-per-caller-token-and-closed-network.md)); без любого из них узел не стартует |
| `ACHIEVEMENTS_GRPC_PORT` | нет, `50051` | порт gRPC-границы (h2c) |
| `ACHIEVEMENTS_NATS_URL` | нет | `nats://[user:password@]host:port`; без него нет ни релея, ни акторов: строки ждут в outbox, стрим дочитается позже |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME` | нет | экспорт логов, трейсов и метрик; без адреса экспорт выключен |

## Гашение выдачи

Ошибочную выдачу мейнтейнер гасит в работающем узле: `bin/achievements rpc 'IO.inspect(Achievements.Maintenance.grants("<identity id>"))'` находит её id, `Achievements.Maintenance.cancel_grant("<grant id>")` гасит, `restore_grant/1` снимает гашение. Погашенная выдача не видна чтениям и держит пару «ачивка набора, субъект»: повтор факта и новое срабатывание правила её не возвращают. На шину ни гашение, ни снятие не выходят.

## Команды

`just achievements-*`: `-tools` ставит Hex, rebar, зависимости по `mix.lock` и плагин `protoc-gen-elixir` версии `protobuf` из `mix.lock`, `-proto` генерирует `lib/generated` (нужен buf), `-build` и `-test` идут с `--warnings-as-errors` после генерации, `-test-integration` — L1 на Testcontainers (нужен Docker), `-format-check`, `-run`, `-image`; `-images-tools` ставит npm-зависимости единицы картинок, `-images` перерисовывает PNG, `-images-check` — typecheck, lint и побайтная сверка PNG с шаблоном. Версии Erlang/OTP и Elixir — `.tool-versions`; на Linux их ставит `tools/env/install.sh`.

Уровень тестов выбирает переменная `ACHIEVEMENTS_INTEGRATION_TESTS=1`, а не пропуск: `test/test_helper.exs` исключает тег `:integration` на L0 и роняет прогон на пропущенном тесте и на недоборе до порога уровня. Добавил или удалил тест — поправь порог тем же изменением. Механику реестра L1 проверяет на тестовых определениях и правилах `test/support/rules.ex`. Правила поставки L0 гоняет харнессом `test/support/rule_run.ex` по сообщениям в настоящем протобуфе (`test/support/auction_events.ex`) без базы, так же как `Ledger`: виды `reads/0`, дата начала, дедупликация по `event_id`, круг состояния через JSON и один держатель на событие. Совпадение харнесса с `Ledger` держит L1 `test/integration/ledger_test.exs`.

Образ запускает release в interactive-режиме (`RELEASE_MODE=interactive`): модули грузятся по первому вызову, и узел без нагрузки держит около 60 МиБ против 140 в embedded.
