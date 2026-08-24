# NATS Tester

Python CLI tool для тестирования NATS-based микросервисов Solguficky.

## Установка

### 1. Установить Python зависимости

```bash
cd tools/nats-tester

# Создать виртуальное окружение (опционально, но рекомендуется)
python -m venv .venv

# Активировать (Windows)
.venv\Scripts\activate

# Активировать (Linux/Mac)
source .venv/bin/activate

# Установить пакет в editable mode
pip install -e .
```

**Важно:** Protobuf классы уже сгенерированы и включены в репозиторий. Генерировать заново нужно только если изменились `.proto` файлы.

## Текущее состояние

Аукционные схемы удалены из `contracts/proto/` вместе с аукционом, но их сгенерированные классы в `nats_tester/generated/nats/` оставлены: только по ним ещё можно разговаривать с legacy-сервисами. Они заморожены — регенерация их не воспроизводит.

Ни одного NATS-контракта MVP пока не спроектировано, поэтому новых subject у инструмента нет. Единственная действующая схема — `identity/v1`, и это gRPC: subject у неё не бывает, в `EVENT_TYPES` и `COMMAND_TYPES` она не попадает. Генерируется она потому, что раскладка `contracts/proto/` намеренно не различает транспорт — это записано в [Protobuf standard](../../docs/standards/contracts/protobuf.md), а транспорт каждой операции живёт в [integration catalog](../../docs/architecture/integration.md).

### 2. Установить внешние зависимости

**NATS CLI (обязательно):**
```bash
go install github.com/nats-io/natscli/nats@latest
```

**Protocol Buffers Compiler (только для регенерации proto):**
```bash
# Windows (Chocolatey)
choco install protoc

# macOS
brew install protobuf

# Linux
apt install protobuf-compiler
```

### 3. Проверить установку

```bash
nats-tester check
```

Вы должны увидеть:
```
✅ nats:     nats version 0.x.x
✅ protobuf: generated classes found
✅ All tools installed!
```

## Использование

После установки команда `nats-tester` доступна глобально.

### Показать справку

```bash
nats-tester --help
```

### Основные команды

#### 1. Опубликовать событие

```bash
# Опубликовать событие из JSON файла (тип определяется автоматически по subject)
nats-tester publish samples/bid_placed_with_previous.json

# С кастомными параметрами
nats-tester publish samples/bid_placed_with_previous.json \
    --nats-url nats://localhost:4222 \
    --subject events.auction.bid_placed

# Явно указать тип события
nats-tester publish samples/my_event.json \
    --subject events.auction.lot_sold \
    --event-type events.auction.lot_sold
```

#### 2. Подписаться на сообщения

```bash
# Подписаться на все команды Telegram (по умолчанию)
nats-tester subscribe

# Подписаться на все события аукциона
nats-tester subscribe --subject "events.auction.>"

# Подписаться на конкретную команду
nats-tester subscribe --subject "commands.telegram.send_message"

# Остановить: Ctrl+C
```

Сообщения автоматически декодируются в JSON на основе subject.

#### 3. Запустить интеграционный тест

```bash
nats-tester test
```

Эта команда:
1. Публикует тестовое событие с `previous_leader_id`
2. Показывает как проверить результат

#### 4. Валидировать JSON

```bash
# Проверить JSON файл перед отправкой (по умолчанию BidPlacedEvent)
nats-tester validate samples/bid_placed_with_previous.json

# Валидация для другого типа события
nats-tester validate samples/lot_sold.json --event-type events.auction.lot_sold
```

#### 5. Просмотреть поддерживаемые типы сообщений

```bash
# Показать все зарегистрированные типы (события и команды)
nats-tester list-types
```

#### 6. Проверить зависимости

```bash
# Проверить установлены ли nats CLI и protobuf классы
nats-tester check
```

## Примеры использования

### Сценарий 1: Базовое тестирование

**Терминал 1 - Запустить Notifications Service:**
```bash
cd legacy/notifications-service
dotnet run
```

**Терминал 2 - Подписаться на команды:**
```bash
nats-tester subscribe
```

**Терминал 3 - Опубликовать событие:**
```bash
nats-tester publish samples/bid_placed_with_previous.json
```

**Ожидаемый результат в Терминале 2:**
```
📨 Message #1
   [#1] Received on "commands.telegram.send_message"
   Decoded:
   Type: SendMessageCommand
   JSON:
     {
       "chat_id": "123",
       "text": "❗ Ваша ставка в 100 рублей на лот 'Значок Клоун' была перебита...",
       "parse_mode": ""
     }
```

### Сценарий 2: Тестирование с Docker

**1. Запустить инфраструктуру:**
```bash
cd legacy/notifications-service
docker-compose up -d
```

**2. Подписаться на команды:**
```bash
nats-tester subscribe
```

**3. Опубликовать событие:**
```bash
nats-tester publish samples/bid_placed_with_previous.json
```

**4. Посмотреть логи сервиса:**
```bash
docker-compose logs -f notifications-service
```

**5. Остановить:**
```bash
docker-compose down
```

### Сценарий 3: Тестирование разных событий

```bash
# Событие с уведомлением (есть previous_leader_id)
nats-tester publish samples/bid_placed_with_previous.json

# Событие без уведомления (нет previous_leader_id)
nats-tester publish samples/bid_placed_no_previous.json
```

### Сценарий 4: Создание кастомного события

```bash
# Скопировать шаблон
cp samples/bid_placed_with_previous.json samples/my_event.json

# Отредактировать my_event.json в любом редакторе

# Валидировать перед отправкой
nats-tester validate samples/my_event.json

# Опубликовать
nats-tester publish samples/my_event.json
```

### Сценарий 5: Подключение к удаленному NATS

```bash
# Production/Staging
nats-tester publish samples/bid_placed_with_previous.json \
    --nats-url nats://staging-nats:4222

nats-tester subscribe --nats-url nats://staging-nats:4222
```

## Структура JSON событий

### BidPlacedEvent

```json
{
  "event_id": "unique-id",           // Уникальный ID события (обязательно)
  "lot_id": 42,                       // ID лота (обязательно)
  "user_id": 200,                     // ID пользователя (обязательно)
  "amount": 150.0,                    // Сумма новой ставки (обязательно)
  "previous_leader_id": 123,          // ID предыдущего лидера (опционально!)
  "current_leader_id": 200,           // ID текущего лидера (обязательно)
  "lot_title": "Название",            // Название лота (обязательно)
  "previous_amount": 100.0            // Предыдущая сумма (обязательно)
}
```

**Важно:**
- Если `previous_leader_id` **присутствует** → Notifications Service отправит уведомление
- Если `previous_leader_id` **отсутствует** → уведомление НЕ будет отправлено

## Добавление новых типов событий

### Шаг 1: Добавить proto определение

Создайте или обновите `.proto` файл в `contracts/proto/<домен>/v<major>/` — раскладка по домену-владельцу и major-версии описана в [Protobuf standard](../../docs/standards/contracts/protobuf.md):

```protobuf
// contracts/proto/meetups/v1/meetup_events.proto
message LotSoldEvent {
  string event_id = 1;
  uint32 lot_id = 2;
  int64 winner_id = 3;
  double final_price = 4;
  string lot_title = 5;
}
```

### Шаг 2: Регенерировать Python классы

```bash
cd tools/nats-tester

# Убедитесь что protoc установлен
protoc --version

# Регенерировать
python generate_proto.py
```

Список файлов в скрипте не ведётся: он обходит `contracts/proto/` и компилирует всё, что найдёт. Захардкоженный перечень пережил бы удаление схем, которые называет, и упал бы много позже самого удаления.

### Шаг 3: Зарегистрировать в CLI

Отредактируйте `nats_tester/cli.py` и добавьте новый тип в соответствующий маппинг:

**Для событий (Events):**
```python
EVENT_TYPES = {
    'events.auction.bid_placed': auction_events_pb2.BidPlacedEvent,
    'events.auction.lot_sold': auction_events_pb2.LotSoldEvent,  # ← новое
}
```

**Для команд (Commands):**
```python
COMMAND_TYPES = {
    'commands.telegram.send_message': telegram_commands_pb2.SendMessageCommand,
    'commands.email.send_email': email_commands_pb2.SendEmailCommand,  # ← новое
}
```

Маппинги используются для:
- `EVENT_TYPES` — публикация (`publish`) и валидация (`validate`)
- `COMMAND_TYPES` — подписка и декодирование (`subscribe`)
- Оба автоматически объединяются в `ALL_MESSAGE_TYPES` для универсального использования

### Шаг 4: Переустановить и использовать

```bash
# Переустановить пакет
pip install -e .

# Проверить что тип добавлен
nats-tester list-types

# Использовать
nats-tester publish samples/lot_sold.json --subject events.auction.lot_sold
```

### Преимущества автоматической конвертации

CLI использует `google.protobuf.json_format` для автоматической конвертации JSON → Protobuf:

- ✅ Не нужно вручную маппить поля
- ✅ Автоматическая валидация типов
- ✅ Поддержка optional полей
- ✅ Поддержка вложенных сообщений
- ✅ Понятные сообщения об ошибках

## Расширенные возможности

### Использование как Python модуля

```python
from nats_tester.cli import publish, subscribe

# Программное использование
publish('samples/bid_placed_with_previous.json')
subscribe(nats_url='nats://localhost:4222')
```

### Добавление новых команд

Отредактируйте `nats_tester/cli.py` и добавьте новую команду:

```python
@cli.command()
@click.argument('arg')
def my_command(arg):
    """My custom command."""
    click.echo(f"Running with {arg}")
```

Команда автоматически станет доступна:
```bash
nats-tester my-command value
```

## Troubleshooting

### Ошибка: "command not found: nats-tester"

**Решение:**
```bash
# Переустановить в editable mode
pip install -e .

# Или добавить в PATH (если установили глобально)
pip install --user -e .
```

### Ошибка: "Generated protobuf files not found"

**Решение:**
```bash
# Регенерировать proto файлы
python generate_proto.py

# Переустановить
pip install -e .
```

### Ошибка: "nats not found"

**Решение:**
```bash
go install github.com/nats-io/natscli/nats@latest

# Убедитесь что $GOPATH/bin в PATH
```

### Ошибка: "Failed to connect to NATS"

**Решение:**
```bash
# Проверить что NATS сервер запущен
docker run -p 4222:4222 nats:latest

# Или
nats-server
```

### Ошибка: "Missing required field in JSON"

**Решение:**
Проверьте структуру JSON файла. Все поля кроме `previous_leader_id` обязательны:
```bash
nats-tester validate samples/my_event.json
```

## Технические детали

### Архитектура

```
nats-tester/
├── nats_tester/
│   ├── cli.py                   # Главный CLI (Click)
│   │                            # EVENT_TYPES: маппинг events subject → protobuf class
│   │                            # COMMAND_TYPES: маппинг commands subject → protobuf class
│   │                            # ALL_MESSAGE_TYPES: объединение всех типов
│   └── generated/               # Сгенерированные Protobuf классы
│       ├── identity/v1/         # действующая схема; gRPC, subject не имеет
│       │   └── identity_service_pb2.py
│       └── nats/                # заморожено: схем в contracts/proto больше нет
│           ├── events/
│           │   └── auction_events_pb2.py
│           └── commands/
│               ├── auction_commands_pb2.py
│               └── telegram_commands_pb2.py
├── samples/                     # Примеры JSON событий
├── generate_proto.py            # Скрипт генерации Protobuf
├── pyproject.toml               # Python package config
└── README.md                    # Документация
```

### Преимущества native Python Protobuf

- ✅ Нет зависимости от `protoc` в runtime
- ✅ Типобезопасность через Python классы
- ✅ Автоматическая конвертация JSON → Protobuf через `json_format`
- ✅ Быстрее (нет subprocess вызовов для encoding)
- ✅ Лучшие сообщения об ошибках
- ✅ Легко расширять новыми типами событий
- ✅ Легче отлаживать

### Как это работает

```python
# 1. JSON файл
{
  "event_id": "test-001",
  "lot_id": 42,
  "user_id": 200,
  "amount": 150.0
}

# 2. Автоматическая конвертация через json_format
from google.protobuf import json_format
event = json_format.Parse(json_data, BidPlacedEvent())

# 3. Сериализация в binary Protobuf
protobuf_bytes = event.SerializeToString()

# 4. Публикация в NATS
nats pub events.auction.bid_placed <protobuf_bytes>
```

## Разработка

### Запуск без установки

```bash
python -m nats_tester.cli --help
python -m nats_tester.cli publish samples/bid_placed_with_previous.json
```

### Добавление тестов

```bash
# Установить dev зависимости
pip install -e ".[dev]"

# Запустить тесты
pytest
```

## См. также

- [Notifications Service Documentation](../../legacy/notifications-service/README.md)
- [NATS CLI Documentation](https://docs.nats.io/using-nats/nats-tools/nats_cli)
- [Protocol Buffers Guide](https://protobuf.dev/)
- [Click Documentation](https://click.palletsprojects.com/)
