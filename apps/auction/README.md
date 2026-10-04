# Auction

Auction Service на Scala 3 и Apache Pekko. Ответственность сервиса — [бриф](../../docs/services/auction.md), стек — [ADR-045](../../docs/decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md), сборка и кодогенерация — [ADR-048](../../docs/decisions/ADR-048-auction-sbt-and-scalapb-build.md).

Сейчас здесь одноузловой кластер с Cluster Sharding, журнал и snapshots Pekko Persistence JDBC в своей базе PostgreSQL, entity лота, которая открывает торги и принимает ставку, каталог карточек лота, HTTP-граница с health-эндпоинтом, gRPC-граница `AuctionService` с проверкой вызывающего, кодогенерация Protobuf из `contracts/proto` и тесты. По gRPC открыты ставка (`PlaceBid`), прокси-лимиты, команды каталога (`CreateLotCard`, `EditLotCard`) с изображением лота, чтение лота (`GetLot`, `ListAuctionLots`) из read model проекции и его изображения (`GetLotImage`) из строки каталога, рождение аукциона у сходки (`DraftAuction`), реестр лотов (`AddLot`, `RemoveLot`) с правом администратора у Meetups и чтения аукционов (`GetMeetupAuction`, `ListAuctions`); имя участника отвечает `UNIMPLEMENTED` до своего листа, счета (`MarkInvoicePaid`, `MarkInvoiceHandedOver`, `ChooseFulfillment`, `ListMyInvoices`, `ListAuctionInvoices`) — до листа счёта PER-338. Машины аукциона — планирования и открытия торгов — в сервисе ещё нет.

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

# Тесты L1: схема, журнал, шардинг, проекция и готовность на PostgreSQL в Testcontainers; нужен Docker
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
| `AUCTION_GRPC_HOST` | `127.0.0.1` | адрес, на котором сервис слушает gRPC |
| `AUCTION_GRPC_PORT` | `8081` | порт gRPC-границы, h2c |
| `AUCTION_CALLER_TOKEN_HUB_BOT` | нет, обязательна | токен бота хаба как вызывающего ([ADR-056](../../docs/decisions/ADR-056-service-calls-per-caller-token-and-closed-network.md)) |
| `AUCTION_CALLER_TOKEN_AUCTION_BOT` | нет, обязательна | токен бота аукциона как вызывающего; значение отличается от токена бота хаба |
| `AUCTION_MEETUPS_GRPC_URL` | нет | адрес gRPC Meetups, `http://<хост>:<порт>`, для проверки права администратора сходки; без него команды администратора аукциону отвечают `UNAVAILABLE` |
| `AUCTION_SERVICE_TOKEN` | нет, обязательна при адресе Meetups | собственный токен Auction как вызывающего Meetups; не совпадает ни с одним токеном вызывающих |
| `AUCTION_DATABASE_JDBC_URL` | нет, обязательна | JDBC URL базы Auction без учётных данных, `jdbc:postgresql://<хост>:<порт>/auction` |
| `AUCTION_DATABASE_USER` | нет, обязательна | пользователь базы |
| `AUCTION_DATABASE_PASSWORD` | нет, обязательна | пароль базы |
| `AUCTION_NATS_URL` | нет | адрес NATS для релея фактов лота, `nats://[<пользователь>:<пароль>@]<хост>:<порт>`; без него релей не стартует, а факты ждут в outbox |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | нет | адрес OTLP-коллектора для метрик проекции; без него экспорт метрик выключен. Остальные `OTEL_*` читает SDK, их подставляет AppHost |

Переопределение живёт в `src/main/resources/application.conf`: код читает готовое значение и о способе переопределения не знает. На старте сервис применяет схему журнала миграциями Flyway; без переменных базы, без токена любого из вызывающих, с одинаковыми токенами у двух вызывающих, с адресом Meetups без своего токена или со своим токеном, равным токену вызывающего, или при отказе миграции он завершается с ненулевым кодом и называет причину, но не значение токена.

## Production-образ

```bash
just auction-image
IMAGE_ENGINE=docker just auction-image
```

Образ собирается по `Containerfile` из контекста корня репозитория: кодогенерации ScalaPB нужен `contracts/proto`. Что попадает в контекст, решает `Containerfile.dockerignore` — список разрешённого, поэтому `target/` и тесты рабочего дерева в сборку не доезжают. JDK и sbt на машине не нужны: стадия `build` на `eclipse-temurin` JDK ставит sbt из релиза GitHub по записанной в `Containerfile` контрольной сумме, генерирует код, компилирует и складывает jar'ы runtime classpath в `/app/lib`. Порядок classpath держит argfile JVM `/app/classpath`, а не `-cp /app/lib/*`, у которого порядок — порядок каталога.

- Каждая внешняя база закреплена по digest; `tools/image/check-containerfile.sh` роняет сборку на теге кодом `SOLG-IMG-TAG`. Мажор JDK в базе сборки обязан совпадать с `.java-version`, версия sbt — с `project/build.properties`: сверки в стадии `build` роняют сборку на расхождении. Новая версия sbt меняет и контрольную сумму в `Containerfile`.
- Финальная база — `eclipse-temurin` JRE, а не distroless: `podman run --rm <образ> id` исполняет `id` из образа, а канарейки `tools/image/check-test.sh` собираются на ней же и исполняют `RUN`. Процесс идёт от uid 1000, команда стоит в CMD в exec-форме, и SIGTERM доходит до JVM. Образ задаёт `AUCTION_HTTP_HOST` и `AUCTION_GRPC_HOST` равными `0.0.0.0`: умолчание `127.0.0.1` из контейнера недостижимо. Куча — 60% лимита памяти контейнера: остальное занимают metaspace, code cache и стеки потоков.
- Пустая база проверена запуском с `--read-only --memory 512m` против PostgreSQL 16: Flyway применяет шесть миграций, узел выходит в `Up`, `/health` отвечает `200` примерно через шесть секунд, процесс держит около 240 МиБ. Остановленная база даёт `503` с причиной `journal`. На `SIGTERM` запускается coordinated shutdown, и узел выходит из кластера за две секунды.

Публикацию делает только CI: `.github/workflows/image-auction.yml` вызывает переиспользуемый `image-publish.yml` веткой `containerfile`, как образы Identity и Hub Bot. Pull request собирает и проверяет образ, ничего не записывая в реестр; push в `develop` публикует `ghcr.io/solguficky/auction` с SBOM и attestation на registry digest. В чарте прода Auction — workload с HTTP-пробами: readiness спрашивает `/health`, startup и liveness — TCP-подключение к HTTP-порту, потому что `/health` при недоступной базе отвечает `503` и перезапускал бы под по кругу ([ADR-055](../../docs/decisions/ADR-055-k3s-runtime-from-aspire-chart.md)).

## Проверка

```bash
AUCTION_HTTP_PORT=8080 AUCTION_DATABASE_JDBC_URL=jdbc:postgresql://127.0.0.1:5432/auction AUCTION_DATABASE_USER=postgres AUCTION_DATABASE_PASSWORD=postgres AUCTION_CALLER_TOKEN_HUB_BOT=hub-local AUCTION_CALLER_TOKEN_AUCTION_BOT=auction-local just auction-run
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

gRPC-вызов идёт с токеном вызывающего в `authorization: Bearer`. Reflection сервис не отдаёт, поэтому `grpcurl` получает схему из `contracts/proto`:

```bash
grpcurl -plaintext -import-path contracts/proto -proto auction/v1/auction_service.proto   -H 'authorization: Bearer hub-local' -H 'x-request-id: local-probe'   -d '{"viewer":{"identity_id":"01890a5d-ac96-774b-bcce-b302099a8057","global_roles":["GLOBAL_ROLE_PUBLIC"]},"lot_id":"01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e5f","amount":{"minor_units":150,"currency":"RUB"},"op_id":"01890a5d-ac98-7aaa-8bbb-cccccccccccc"}'   127.0.0.1:8081 auction.v1.AuctionService/PlaceBid
```

На лот, которого нет, ответ — `NotFound`; без заголовка `authorization` или с чужим токеном — `Unauthenticated` до обращения к лоту. Запись границы — `request handled` с `operation=auction.v1.AuctionService/PlaceBid`, `grpc_code`, `caller` у допущенного вызова и `caller_refusal` (`missing_token`, `unknown_token`, `not_declared`) у отказанного. Токен, тело запроса и сообщение неожиданного исключения в запись не попадают: у такого отказа `error` — только класс исключения, а `stack` — классы и кадры без сообщений.

Сервис запускается в отдельной JVM (`run / fork := true` в `build.sbt`), поэтому останавливать его надо через сам sbt — Ctrl-C в его терминале. Убитый мимо sbt процесс оставляет и работающую JVM приложения, и блокировку сервера sbt; следующий запуск падает на `ServerAlreadyBootingException`. Лечится остановкой оставшихся java-процессов этого каталога и удалением `project/target/active.json`.
