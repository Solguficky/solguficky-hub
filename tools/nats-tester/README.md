# NATS Tester

CLI для ручной проверки сообщений на шине: публикует Protobuf-сообщение из JSON-файла, подписывается на subject и декодирует то, что по нему приходит, читает durable consumer JetStream и показывает топологию стримов.

## Текущее состояние

Реестр знает тридцать девять subjects. Первый — `events.notifications.notification_created`, адресный факт уведомления по схеме `notifications/v1`. Одиннадцать — поводы журнала сходок, `events.meetups.<повод>` по схеме `meetups/v1/meetups_events.proto`. Пять — поводы доступа человека, `events.identity.<повод>` по схеме `identity/v1/identity_events.proto`. Ещё двадцать два — поводы аукциона, `events.auction.<повод>` по схеме `auction/v1/auction_events.proto`: одиннадцать у лота и одиннадцать у сессии. У Meetups и Identity сообщение домена одно — `meetups.v1.MeetupEvent` и `identity.v1.IdentityEvent`; у Auction их два под одним префиксом — `auction.v1.LotEvent` и `auction.v1.SessionEvent`, — и тип читается из реестра по subject'у. Повод в каждом называют и subject, и ветка `oneof occasion` внутри сообщения. Это соответствие держит не комментарий, а гейт: он выводит ожидаемые subjects из веток схемы и сверяет их с реестром в обе стороны.

Инструмент оставлен и входит в гейты: `just nats-tester-check` гоняется в `just verify`, а джоба `nats-tester` в CI вдобавок перегенерирует классы закреплённым `protoc` и падает на расхождении со схемами. Сгенерированные классы коммитятся намеренно — установка без `protoc` и есть смысл ручного инструмента, — и это единственное такое исключение в репозитории: у Go, TypeScript, .NET и Scala генерация лежит в `.gitignore` или `obj/`. Плата за исключение — проверка: классы, которые не импортируются или разошлись со схемой, краснеют в гейте, а не при ручной отладке шины.

Генерация сужена до схем, у которых бывает subject, и их импортов — `NATS_PROTO_FILES` в `nats_tester/proto_sources.py`: сейчас это `auction/v1/auction_events.proto`, `identity/v1/identity_events.proto`, `meetups/v1/meetups_events.proto` и `notifications/v1/notifications.proto`. Схемы `auction/v1/auction_service.proto`, `identity/v1/identity_service.proto`, `meetups/v1/meetups_service.proto` и `notifications/v1/notifications_service.proto` обслуживают gRPC: subject у них не бывает, и классов для них больше нет. `auction/v1/auction.proto`, `meetups/v1/meetups.proto` и `identity/v1/roles.proto` собираются как payload, потому что их импортируют схемы событий своих доменов: раскладка `contracts/proto/` намеренно не различает транспорт — это записано в [Protobuf standard](../../docs/standards/contracts/protobuf.md), а транспорт каждой операции живёт в [integration catalog](../../docs/architecture/integration.md).

Новый тип сообщения добавляется по шагам ниже: схема в `contracts/proto/`, запись в `NATS_PROTO_FILES` и реестр, регенерация классов.

## Установка

### 1. Python-зависимости

```bash
# Из корня репозитория
just nats-tester-tools
```

Или напрямую:

```bash
cd tools/nats-tester
python -m pip install -e .
```

Сгенерированные Protobuf-классы лежат в репозитории, поэтому `protoc` для установки не нужен. Он нужен только для регенерации.

### 2. Внешние зависимости

**NATS CLI (обязательно для `publish`):**
```bash
go install github.com/nats-io/natscli/nats@latest
```

**protoc (только для регенерации классов):**

Версия закреплена переменной `PROTOC_VERSION` в корневом `justfile` — сейчас `33.0`. Gencode проверяет версию рантайма на импорте, поэтому `protoc` другой линии даёт другой файл; пакет дистрибутива обычно старее. Нужный релиз берётся со страницы [protocolbuffers/protobuf releases](https://github.com/protocolbuffers/protobuf/releases): `protoc-33.0-win64.zip`, `protoc-33.0-linux-x86_64.zip`, `protoc-33.0-osx-universal_binary.zip`. Распакуйте архив и добавьте его `bin/` в `PATH`.

### 3. Проверить установку

```bash
nats-tester check
```

## Команды

```bash
nats-tester --help
```

| Команда | Что делает |
|---|---|
| `publish FILE --subject S` | Читает JSON, кодирует в Protobuf по типу из реестра, публикует в NATS с заголовком `Nats-Msg-Id` = `event_id`; `--msg-id` задаёт свой, `--no-msg-id` снимает |
| `subscribe [--subject S]` | Слушает subject (по умолчанию `>`), декодирует известные типы, неизвестные показывает как сырые |
| `consume --stream S --durable D [--drain]` | Читает существующий durable JetStream, подтверждает каждое сообщение и помечает повтор по `event_id`; `--drain` выходит, когда читать нечего |
| `streams` | Показывает стримы, их retention и окно дедупликации и позиции durable consumers |
| `validate FILE --event-type S` | Проверяет, что JSON соответствует схеме, без обращения к сети |
| `list-types` | Показывает зарегистрированные subjects |
| `check` | Проверяет наличие `nats` CLI и то, что сгенерированные классы проходят проверки гейта |
| `gen-id` | Печатает UUIDv7 ([ADR-020](../../docs/decisions/ADR-020-uuidv7-identifiers.md)) |

Подписка работает и с пустым реестром: сообщения по неизвестному subject показываются с размером и сырым телом. Публикация — нет: без записи в реестре тип сообщения определить не из чего.

## Добавление типа сообщения

### Шаг 1. Схема

Создайте или обновите `.proto` в `contracts/proto/<домен>/v<major>/` — раскладка по домену-владельцу и major-версии описана в [Protobuf standard](../../docs/standards/contracts/protobuf.md). Изменение контракта выполняется через skill `proj-change-contract` и обновляет [integration catalog](../../docs/architecture/integration.md) в том же изменении.

```protobuf
// contracts/proto/meetups/v1/meetup_events.proto
message MeetupPublishedEvent {
  string event_id = 1;
  string meetup_id = 2;
}
```

### Шаг 2. Запись в набор генерации

Добавьте схему в `NATS_PROTO_FILES` в `nats_tester/proto_sources.py`:

```python
NATS_PROTO_FILES: tuple[str, ...] = (
    "notifications/v1/notifications.proto",
    "meetups/v1/meetup_events.proto",
)
```

Список называет только схемы шины: gRPC-схемы в него не попадают, а их импорты добавляются сами. Замыкание обязательно — `protoc` пишет в сгенерированный модуль импорт зависимости, и без её класса модуль не импортируется.

### Шаг 3. Регенерация классов

```bash
# Из корня репозитория; нужен protoc закреплённой версии
just nats-tester-proto
```

Или `cd tools/nats-tester && python generate_proto.py`. Скрипт компилирует набор, переписывает импорты от корня модуля под пакет `nats_tester.generated` и убирает классы схем, которых в наборе больше нет. Импорт от корня, оставшийся после переписывания, валит скрипт: в пакете такого имени нет, и модуль не импортировался бы.

### Шаг 4. Регистрация subject

В `nats_tester/registry.py` добавьте запись в нужный маппинг:

```python
from nats_tester.generated.meetups.v1 import meetup_events_pb2

EVENT_TYPES: dict[str, Type[Message]] = {
    'events.meetups.published': meetup_events_pb2.MeetupPublishedEvent,
}
```

- `EVENT_TYPES` используется публикацией и валидацией;
- `COMMAND_TYPES` — тем же плюс декодированием при подписке;
- оба объединяются в `ALL_MESSAGE_TYPES`.

### Шаг 5. Проверка

```bash
# Из корня репозитория
just nats-tester-check
```

Проверка сверяет реестр и состав `nats_tester/generated/` со схемами; тем же рецептом краснеет `just verify`. Она же держит два соглашения, которые иначе жили бы только в прозе: subjects домена фактов выводятся из веток его `oneof occasion` и сверяются с реестром в обе стороны, а конверт события у всех таких доменов совпадает по номерам, типам и смыслу пяти полей. Второе нигде больше не проверяется: раздельные определения в разных пакетах не видят одновременно ни `buf lint`, ни `buf breaking`, ни сборка потребителя.

## Проверка топологии JetStream

Стримы и durable consumers создаёт AppHost на старте узла `nats` ([каталог интеграций](../../docs/architecture/integration.md#jetstream)). У инструмента свои durable — `nats-tester-meetups-events`, `nats-tester-identity-events` и `nats-tester-notifications-events`, — поэтому ручная проверка не сдвигает позицию Notifications.

Порт и пароль шины назначает Aspire: порт берётся из дашборда или `aspire describe nats`, пароль — параметр `nats-password` в user secrets AppHost. Адрес собирается как `nats://nats:<пароль>@localhost:<порт>` и передаётся флагом `--nats-url` каждой команде ниже.

```bash
# Топология применена: стримы, retention, окно дедупликации, позиции durable
nats-tester streams

# Дважды с одним Nats-Msg-Id — в стриме одно сообщение: повтор отбросил сервер
nats-tester publish created.json --subject events.meetups.meetup_created
nats-tester publish created.json --subject events.meetups.meetup_created

# Повтор без заголовка доходит до потребителя
nats-tester publish created.json --subject events.meetups.meetup_created --no-msg-id

# Потребитель: второе сообщение с тем же event_id помечается DUPLICATE
nats-tester consume --stream MEETUPS_EVENTS --durable nats-tester-meetups-events --drain

# Опубликовать, пока потребитель выключен, и прочитать снова: придёт только новое
nats-tester consume --stream MEETUPS_EVENTS --durable nats-tester-meetups-events --drain
```

Множество увиденных `event_id` у `consume` живёт в памяти одного запуска. Настоящий потребитель держит его в своём хранилище той же транзакцией, что и эффект события; инструмент показывает правило, а не реализует его хранилище.

## Как это работает

```python
# 1. JSON-файл
{"event_id": "test-001", "meetup_id": "0199..."}

# 2. Конвертация через json_format — маппить поля руками не нужно
from google.protobuf import json_format
event = json_format.Parse(json_data, MeetupPublishedEvent())

# 3. Сериализация
protobuf_bytes = event.SerializeToString()

# 4. Публикация через nats CLI
```

`google.protobuf.json_format` даёт валидацию типов, поддержку `optional` и вложенных сообщений и понятные ошибки.

## Структура

```
nats-tester/
├── nats_tester/
│   ├── cli.py                   # CLI на Click
│   ├── gate.py                  # проверки: импорт, состав генерации, реестр, subjects, конверт
│   ├── proto_sources.py         # NATS_PROTO_FILES — схемы шины и замыкание импортов
│   ├── registry.py              # EVENT_TYPES / COMMAND_TYPES — реестр subjects
│   └── generated/               # Сгенерированные Protobuf-классы; коммитятся намеренно
│       ├── identity/v1/roles_pb2.py              # импорт схемы событий Identity
│       ├── meetups/v1/meetups_pb2.py             # импорт схемы уведомления
│       └── notifications/v1/notifications_pb2.py # subject записан в registry.py
├── generate_proto.py            # Генерация набора и удаление классов вне его
├── pyproject.toml
└── README.md
```

## Troubleshooting

**`command not found: nats-tester`** — `just nats-tester-tools`, либо `$HOME/.local/bin` не в `PATH`.

**`Generated protobuf files not found`** — `just nats-tester-proto`, затем `just nats-tester-tools`.

**`ImportError: cannot import name 'runtime_version'`** или **`VersionError: gencode ... runtime ...`** — рантайм `protobuf` старше закоммиченных классов. Их gencode проверяет версию рантайма на импорте, а `cli.py` импортирует классы на уровне модуля, поэтому падает любая команда, включая `list-types`. Нижняя граница объявлена в `pyproject.toml`: `pip install -e . --upgrade`. Тот же случай краснеет в `just nats-tester-check` и в джобе `nats-tester`.

**`gencode` новее или старше вашего `protoc`** — регенерация требует `protoc` той линии, что объявленный рантайм `protobuf`: `protoc` 33.0 даёт gencode `6.33.0`. Версия закреплена в `justfile` (`PROTOC_VERSION`); релиз с [github.com/protocolbuffers/protobuf/releases](https://github.com/protocolbuffers/protobuf/releases).

**`nats not found`** — установите NATS CLI и добавьте `$(go env GOPATH)/bin` в `PATH`.

**`Failed to connect to NATS`** — сервер не поднят. Локально NATS запускает AppHost: `cd infra/apphost && aspire run`.

**`Unknown message type for subject`** — subject не зарегистрирован в `registry.py`; см. «Добавление типа сообщения».

**`nats-tester: generated classes are out of sync with the schemas`** — проверка гейта нашла расхождение: названный модуль не импортируется, отсутствует, лишний или зарегистрирован из схемы вне набора генерации. Лечится `just nats-tester-proto`; если расхождение осталось, названная схема не входит в `NATS_PROTO_FILES` или реестр ссылается на gRPC-схему.

## Разработка

```bash
# Запуск без установки
python -m nats_tester.cli --help

# То, что гоняет just verify
just nats-tester-check
```

Тестов у инструмента нет намеренно: проверяемое здесь — не поведение CLI, а согласие классов со схемами и реестром, и это выражено гейтом, а не тестом.

## См. также

- [Межсервисное взаимодействие](../../docs/architecture/integration.md)
- [Protobuf standard](../../docs/standards/contracts/protobuf.md)
- [NATS CLI Documentation](https://docs.nats.io/using-nats/nats-tools/nats_cli)
- [Protocol Buffers Guide](https://protobuf.dev/)
- [Click Documentation](https://click.palletsprojects.com/)
