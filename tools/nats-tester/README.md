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

### 2. Установить внешние зависимости

**NATS CLI:**
```bash
go install github.com/nats-io/natscli/nats@latest
```

**Protocol Buffers Compiler:**
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
✅ protoc: libprotoc 3.x.x
✅ nats:   nats version 0.x.x
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
# Опубликовать событие из JSON файла
nats-tester publish samples/bid_placed_with_previous.json

# С кастомными параметрами
nats-tester publish samples/bid_placed_with_previous.json \
    --nats-url nats://localhost:4222 \
    --subject events.auction.bid_placed
```

#### 2. Подписаться на команды

```bash
# Подписаться на все команды Telegram
nats-tester subscribe

# С кастомным subject
nats-tester subscribe --subject "commands.telegram.send_message"

# Остановить: Ctrl+C
```

#### 3. Запустить интеграционный тест

```bash
nats-tester test
```

Эта команда:
1. Публикует тестовое событие с `previous_leader_id`
2. Показывает как проверить результат

#### 4. Валидировать JSON

```bash
# Проверить JSON файл перед отправкой
nats-tester validate samples/bid_placed_with_previous.json
```

#### 5. Проверить зависимости

```bash
# Проверить установлены ли protoc и nats CLI
nats-tester check
```

## Примеры использования

### Сценарий 1: Базовое тестирование

**Терминал 1 - Запустить Notifications Service:**
```bash
cd services/notifications-service
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
   chat_id: 123
   text: "❗ Ваша ставка в 100 рублей на лот 'Значок Клоун' была перебита..."
   parse_mode: ""
```

### Сценарий 2: Тестирование разных событий

```bash
# Событие с уведомлением (есть previous_leader_id)
nats-tester publish samples/bid_placed_with_previous.json

# Событие без уведомления (нет previous_leader_id)
nats-tester publish samples/bid_placed_no_previous.json
```

### Сценарий 3: Создание кастомного события

```bash
# Скопировать шаблон
cp samples/bid_placed_with_previous.json samples/my_event.json

# Отредактировать my_event.json в любом редакторе

# Валидировать перед отправкой
nats-tester validate samples/my_event.json

# Опубликовать
nats-tester publish samples/my_event.json
```

### Сценарий 4: Подключение к удаленному NATS

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

### Ошибка: "protoc not found"

**Решение:**
```bash
# Windows
choco install protoc

# Проверить
protoc --version
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

### Ошибка: "Proto directory not found"

**Решение:**
Убедитесь, что вы запускаете команду из правильной директории:
```bash
# Должно работать из любой директории, но если нет:
cd tools/nats-tester

# Или укажите путь явно
nats-tester publish samples/test.json --proto-path ../../contracts/proto
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

## Альтернативы

Если Python CLI не подходит, можно использовать:

1. **justfile** - в `tools/justfile` (более простой, но менее гибкий)
2. **Bash скрипты** - в `tools/scripts/` (для Linux/macOS/WSL)
3. **PowerShell скрипты** - в `tools/scripts/` (для Windows)

## См. также

- [Notifications Service Documentation](../../services/notifications-service/README.md)
- [NATS CLI Documentation](https://docs.nats.io/using-nats/nats-tools/nats_cli)
- [Protocol Buffers Guide](https://protobuf.dev/)
- [Click Documentation](https://click.palletsprojects.com/)

