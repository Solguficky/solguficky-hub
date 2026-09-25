# Auction

Auction Service на Scala 3 и Apache Pekko. Ответственность сервиса — [бриф](../../docs/services/auction.md), стек — [ADR-045](../../docs/decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md), сборка и кодогенерация — [ADR-048](../../docs/decisions/ADR-048-auction-sbt-and-scalapb-build.md).

Сейчас здесь только языковой контур: HTTP-граница с health-эндпоинтом, кодогенерация Protobuf из `contracts/proto` и тесты. Торгов, лотов и persistence в нём нет.

Нужны JDK версии из `.java-version` и sbt. Ни то, ни другое репозиторий не ставит: `just auction-tools` прогревает уже установленный sbt. Одного `update` для этого мало, поэтому рецепт гонит ещё генерацию и проверку формата — `protocbridge` тянет бинарник protoc на первой генерации, а `scalafmt-core` подтягивается на первой проверке. Отсюда два следствия: рецепт оставляет в `target/` вывод кодогенерации и краснеет на неотформатированном коде, то есть повторяет вердикт `just auction-lint` до гейта.

## Команды

```bash
# Прогрев сборки, один раз после клонирования: зависимости, protoc и scalafmt
just auction-tools

# Кодогенерация отдельным шагом; сборка выполняет её сама
just auction-proto

# Сборка сервиса и тестов
just auction-build

# Тесты
just auction-test

# Гейт форматирования и само форматирование
just auction-lint
just auction-format

# Локальный запуск вне Aspire
just auction-run

# Запуск в Aspire вместе с PostgreSQL
just aspire auction
```

## Переменные окружения

| Переменная | Значение по умолчанию | Смысл |
|---|---|---|
| `AUCTION_HTTP_HOST` | `127.0.0.1` | адрес, на котором сервис слушает HTTP |
| `AUCTION_HTTP_PORT` | `8080` | порт HTTP-границы |

Переопределение живёт в `src/main/resources/application.conf`: код читает готовое значение и о способе переопределения не знает.

## Проверка

```bash
AUCTION_HTTP_PORT=8080 just auction-run
```

```bash
curl -i http://127.0.0.1:8080/health
```

Ответ — `200` и тело `{"status":"ok"}`. В логе появляется запись `request handled` с полями `service`, `operation`, `result` и `duration_us`; `use_case` у неё нет намеренно — health-проверку не начинал человек. Свой `request_id` сервис не рождает: если передать заголовок, он попадёт в запись, если нет — поле будет отсутствовать, а не окажется пустым.

```bash
curl -i -H 'x-request-id: local-probe' http://127.0.0.1:8080/health
```

Неизвестный путь тоже попадает в журнал — с `result=error` и `error_category=invariant`, потому что граница запечатывает маршрут у себя внутри и сама отвечает 404:

```bash
curl -i http://127.0.0.1:8080/lots
```

Сервис запускается в отдельной JVM (`run / fork := true` в `build.sbt`), поэтому останавливать его надо через сам sbt — Ctrl-C в его терминале. Убитый мимо sbt процесс оставляет и работающую JVM приложения, и блокировку сервера sbt; следующий запуск падает на `ServerAlreadyBootingException`. Лечится остановкой оставшихся java-процессов этого каталога и удалением `project/target/active.json`.
