# Auction

Auction Service на Scala 3 и Apache Pekko. Ответственность сервиса — [бриф](../../docs/services/auction.md), стек — [ADR-045](../../docs/decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md), сборка и кодогенерация — [ADR-048](../../docs/decisions/ADR-048-auction-sbt-and-scalapb-build.md).

Сейчас здесь инфраструктура торгов без транспорта: одноузловой кластер с Cluster Sharding, журнал и snapshots Pekko Persistence JDBC в своей базе PostgreSQL, entity лота, которая открывает торги и принимает ставку, HTTP-граница с health-эндпоинтом, кодогенерация Protobuf из `contracts/proto` и тесты. Снаружи лот пока недоступен — gRPC-граница придёт отдельно, — а агрегата аукциона в сервисе нет.

Нужны JDK версии из `.java-version` и sbt. Ни то, ни другое репозиторий не ставит: `just auction-tools` прогревает уже установленный sbt. Одного `update` для этого мало, поэтому рецепт гонит ещё генерацию и проверку формата — `protocbridge` тянет бинарник protoc на первой генерации, а `scalafmt-core` подтягивается на первой проверке. Отсюда два следствия: рецепт оставляет в `target/` вывод кодогенерации и краснеет на неотформатированном коде, то есть повторяет вердикт `just auction-lint` до гейта.

## Команды

```bash
# Прогрев сборки, один раз после клонирования: зависимости, protoc и scalafmt
just auction-tools

# Кодогенерация отдельным шагом; сборка выполняет её сама
just auction-proto

# Сборка сервиса и тестов
just auction-build

# Тесты L0, Docker не нужен
just auction-test

# Тесты L1: схема, журнал, шардинг и готовность на PostgreSQL в Testcontainers; нужен Docker
just auction-test-integration

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
| `AUCTION_DATABASE_JDBC_URL` | нет, обязательна | JDBC URL базы Auction без учётных данных, `jdbc:postgresql://<хост>:<порт>/auction` |
| `AUCTION_DATABASE_USER` | нет, обязательна | пользователь базы |
| `AUCTION_DATABASE_PASSWORD` | нет, обязательна | пароль базы |

Переопределение живёт в `src/main/resources/application.conf`: код читает готовое значение и о способе переопределения не знает. На старте сервис применяет схему журнала миграциями Flyway; без переменных базы или при отказе миграции он завершается с ненулевым кодом.

## Проверка

```bash
AUCTION_HTTP_PORT=8080 AUCTION_DATABASE_JDBC_URL=jdbc:postgresql://127.0.0.1:5432/auction AUCTION_DATABASE_USER=postgres AUCTION_DATABASE_PASSWORD=postgres just auction-run
```

```bash
curl -i http://127.0.0.1:8080/health
```

Ответ — `200` и тело `{"status":"ok"}`, когда узел поднялся в кластере и журнал отвечает. До этого или при потерянной базе — `503` и `{"status":"not ready","reason":"cluster"}` либо `"reason":"journal"`; запись границы получает `error_category=dependency_unavailable`. В логе появляется запись `request handled` с полями `service`, `operation`, `result` и `duration_us`; `use_case` у неё нет намеренно — health-проверку не начинал человек. Свой `request_id` сервис не рождает: если передать заголовок, он попадёт в запись, если нет — поле будет отсутствовать, а не окажется пустым.

```bash
curl -i -H 'x-request-id: local-probe' http://127.0.0.1:8080/health
```

Неизвестный путь тоже попадает в журнал — с `result=error` и `error_category=invariant`, потому что граница запечатывает маршрут у себя внутри и сама отвечает 404:

```bash
curl -i http://127.0.0.1:8080/lots
```

Сервис запускается в отдельной JVM (`run / fork := true` в `build.sbt`), поэтому останавливать его надо через сам sbt — Ctrl-C в его терминале. Убитый мимо sbt процесс оставляет и работающую JVM приложения, и блокировку сервера sbt; следующий запуск падает на `ServerAlreadyBootingException`. Лечится остановкой оставшихся java-процессов этого каталога и удалением `project/target/active.json`.
