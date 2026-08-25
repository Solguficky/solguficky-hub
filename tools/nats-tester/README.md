# NATS Tester

CLI для ручной проверки сообщений на шине: публикует Protobuf-сообщение из JSON-файла, подписывается на subject и декодирует то, что по нему приходит.

## Текущее состояние

**Реестр subjects пуст.** Ни одного NATS-контракта пока не принято, поэтому `publish`, `subscribe` и `validate` не знают ни одного типа сообщений и `list-types` показывает ноль.

Единственная действующая схема — `identity/v1`, и это gRPC: subject у неё не бывает, в реестр она не попадает. Генерируется она потому, что раскладка `contracts/proto/` намеренно не различает транспорт — это записано в [Protobuf standard](../../docs/standards/contracts/protobuf.md), а транспорт каждой операции живёт в [integration catalog](../../docs/architecture/integration.md).

Инструмент оживает, когда появится первый принятый NATS-контракт: схема кладётся в `contracts/proto/`, классы генерируются, subject добавляется в реестр — см. «Добавление типа сообщения».

## Установка

### 1. Python-зависимости

```bash
cd tools/nats-tester

# Виртуальное окружение (опционально)
python -m venv .venv
.venv\Scripts\activate      # Windows
source .venv/bin/activate    # Linux/macOS

# Пакет в editable mode
pip install -e .
```

Сгенерированные Protobuf-классы лежат в репозитории. Регенерировать нужно только после изменения `.proto`.

### 2. Внешние зависимости

**NATS CLI (обязательно для `publish`):**
```bash
go install github.com/nats-io/natscli/nats@latest
```

**protoc (только для регенерации классов):**
```bash
choco install protoc                  # Windows
brew install protobuf                 # macOS
apt-get install protobuf-compiler     # Linux
```

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
| `publish FILE --subject S` | Читает JSON, кодирует в Protobuf по типу из реестра, публикует в NATS |
| `subscribe [--subject S]` | Слушает subject (по умолчанию `>`), декодирует известные типы, неизвестные показывает как сырые |
| `validate FILE --event-type S` | Проверяет, что JSON соответствует схеме, без обращения к сети |
| `list-types` | Показывает зарегистрированные subjects |
| `check` | Проверяет наличие `nats` CLI и сгенерированных классов |
| `gen-id` | Печатает UUIDv7 ([ADR-020](../../docs/decisions/ADR-020-uuidv7-identifiers.md)) |

Подписка работает и с пустым реестром: сообщения по неизвестному subject показываются с размером и сырым телом. Публикация — нет: без записи в реестре тип сообщения определить не из чего.

## Добавление типа сообщения

### Шаг 1. Схема

Создайте или обновите `.proto` в `contracts/proto/<домен>/v<major>/` — раскладка по домену-владельцу и major-версии описана в [Protobuf standard](../../docs/standards/contracts/protobuf.md). Изменение контракта выполняется через skill `sgh-change-contract` и обновляет [integration catalog](../../docs/architecture/integration.md) в том же изменении.

```protobuf
// contracts/proto/meetups/v1/meetup_events.proto
message MeetupPublishedEvent {
  string event_id = 1;
  string meetup_id = 2;
}
```

### Шаг 2. Регенерация классов

```bash
cd tools/nats-tester
python generate_proto.py
```

Список файлов в скрипте не ведётся: он обходит `contracts/proto/` и компилирует всё, что найдёт. Захардкоженный перечень пережил бы удаление схем, которые называет, и упал бы много позже самого удаления.

### Шаг 3. Регистрация subject

В `nats_tester/cli.py` добавьте запись в нужный маппинг:

```python
from nats_tester.generated.meetups.v1 import meetup_events_pb2

EVENT_TYPES: dict[str, Type[Message]] = {
    'events.meetups.published': meetup_events_pb2.MeetupPublishedEvent,
}
```

- `EVENT_TYPES` используется публикацией и валидацией;
- `COMMAND_TYPES` — тем же плюс декодированием при подписке;
- оба объединяются в `ALL_MESSAGE_TYPES`.

### Шаг 4. Проверка

```bash
pip install -e .
nats-tester list-types
```

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
│   ├── cli.py                   # CLI на Click; EVENT_TYPES / COMMAND_TYPES — реестр subjects
│   └── generated/               # Сгенерированные Protobuf-классы
│       └── identity/v1/         # gRPC-схема; subject не имеет
│           └── identity_service_pb2.py
├── generate_proto.py            # Обход contracts/proto и вызов protoc
├── pyproject.toml
└── README.md
```

## Troubleshooting

**`command not found: nats-tester`** — `pip install -e .` из `tools/nats-tester`, либо `$HOME/.local/bin` не в `PATH`.

**`Generated protobuf files not found`** — `python generate_proto.py`, затем `pip install -e .`.

**`nats not found`** — установите NATS CLI и добавьте `$(go env GOPATH)/bin` в `PATH`.

**`Failed to connect to NATS`** — сервер не поднят. Локально NATS запускает AppHost: `cd infra/apphost && aspire run`.

**`Unknown message type for subject`** — subject не зарегистрирован в `cli.py`; см. «Добавление типа сообщения».

## Разработка

```bash
# Запуск без установки
python -m nats_tester.cli --help

# Тесты
pip install -e ".[dev]"
pytest
```

## См. также

- [Межсервисное взаимодействие](../../docs/architecture/integration.md)
- [Protobuf standard](../../docs/standards/contracts/protobuf.md)
- [NATS CLI Documentation](https://docs.nats.io/using-nats/nats-tools/nats_cli)
- [Protocol Buffers Guide](https://protobuf.dev/)
- [Click Documentation](https://click.palletsprojects.com/)
