# Локальная Разработка и Запуск

Инструкция по запуску `telegram-gateway` локально с Docker-инфраструктурой.

## Предварительные требования

- Docker и Docker Compose установлены
- Telegram бот создан через [@BotFather](https://t.me/BotFather)
- Git репозиторий склонирован

## Быстрый старт

### 1. Настройка окружения

Скопируйте файл с примером переменных окружения и заполните его:

```bash
# В корне проекта solguficky-hub
cp .env.example .env
```

Отредактируйте `.env` и замените `your_bot_token_here` на ваш реальный токен от BotFather:

```bash
APP_TELEGRAM__TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
APP_NATS__URL=nats://nats:4222
RUST_LOG=info,telegram_gateway=debug
```

### 2. Запуск инфраструктуры

Запустите все сервисы через Docker Compose:

```bash
docker-compose up --build
```

Флаг `--build` пересоберет образ telegram-gateway при изменениях в коде.

### 3. Проверка запуска

**Проверьте логи telegram-gateway:**

```bash
docker-compose logs -f telegram-gateway
```

Вы должны увидеть:
- `Successfully connected to NATS`
- `Subscribed to events.auction.>`
- Сообщения о готовности бота

**Откройте веб-интерфейсы:**

- NATS Monitoring: http://localhost:8222
- Apicurio Registry: http://localhost:8080

**Проверьте доступность через curl:**

```bash
# NATS
curl http://localhost:8222/varz

# Apicurio Registry
curl http://localhost:8080/health
```

### 4. Тестирование бота

1. Откройте Telegram и найдите вашего бота
2. Отправьте команду `/start`
3. Нажмите на кнопку "🎪 Ближайший аукцион"
4. Просмотрите список лотов
5. Нажмите на любой лот для просмотра деталей
6. Попробуйте "📖 Посмотреть описание"
7. Попробуйте "🎯 Начать торги" или "💰 Повысить ставку"

## Отладка и мониторинг

### Просмотр NATS событий через CLI

Установите NATS CLI (опционально):

```bash
# Windows (через Scoop)
scoop install nats

# macOS (через Homebrew)
brew install nats-io/nats-tools/nats

# Linux
curl -sf https://binaries.nats.dev/nats-io/natscli/nats@latest | sh
```

Подпишитесь на все команды аукциона:

```bash
nats sub "commands.auction.>" --server=localhost:4222
```

Теперь каждое действие в боте будет отображаться как Protobuf сообщение в терминале.

### Фильтрация логов

**Только сообщения о публикации команд:**

```bash
docker-compose logs telegram-gateway | grep "Published PlaceBidCommand"
```

**Все события от NATS:**

```bash
docker-compose logs telegram-gateway | grep "Received"
```

**Ошибки:**

```bash
docker-compose logs telegram-gateway | grep "ERROR"
```

### Просмотр зарегистрированных схем

1. Откройте http://localhost:8080
2. Перейдите в раздел "Artifacts"
3. Вы увидите список всех зарегистрированных Protobuf схем
4. Можно просмотреть содержимое, версии и метаданные

## Типичные проблемы

### Бот не отвечает

**Проблема:** Бот не реагирует на команды в Telegram

**Решение:**
1. Проверьте, что контейнер запущен: `docker-compose ps`
2. Проверьте логи: `docker-compose logs telegram-gateway`
3. Убедитесь, что токен в `.env` корректный
4. Проверьте переменную окружения: `docker-compose exec telegram-gateway env | grep TELEGRAM`

### NATS connection refused

**Проблема:** `Failed to connect to NATS`

**Решение:**
1. Убедитесь, что NATS запущен: `docker-compose ps nats`
2. Проверьте URL в `.env`: должен быть `nats://nats:4222` (не localhost!)
3. Перезапустите: `docker-compose restart telegram-gateway`

### PostgreSQL недоступен

**Проблема:** Ошибки `connection refused` при подключении к базе.
**Решение:** Убедитесь, что Docker-контейнер `postgres-db` запущен и работает.

### Ошибка компиляции в Docker

**Проблема:** `cargo build` падает при сборке образа

**Решение:**
1. Убедитесь, что `contracts/proto/` существует и содержит `.proto` файлы
2. Очистите кеш Docker: `docker-compose build --no-cache telegram-gateway`
3. Проверьте доступное место на диске

### Изменения в коде не применяются

**Проблема:** Внесли изменения, но бот работает по-старому

**Решение:**
1. Пересоберите образ: `docker-compose up --build telegram-gateway`
2. Или явно: `docker-compose build telegram-gateway && docker-compose up telegram-gateway`

## Остановка и очистка

**Остановить все сервисы:**

```bash
docker-compose down
```

**Остановить и удалить volumes (БД PostgreSQL):**

```bash
docker-compose down -v
```

**Удалить образы (освободить место):**

```bash
docker-compose down --rmi all
```

## Разработка без Docker

Если нужно запустить telegram-gateway локально без Docker:

```bash
cd services/telegram-gateway

# Запустите только инфраструктуру в Docker
docker-compose up -d nats apicurio-registry postgres

# Установите переменные окружения для локального запуска
export APP_TELEGRAM__TOKEN="ваш_токен"
export APP_NATS__URL="nats://localhost:4222"
export RUST_LOG="info,telegram_gateway=debug"

# Запустите сервис
cargo run
```

**Преимущества:**
- Быстрая перекомпиляция при изменениях
- Прямая отладка через IDE
- Удобный доступ к stdout

**Недостатки:**
- Нужна локальная установка Rust toolchain
- Нужно вручно управлять переменными окружения

## Следующие шаги

После успешного запуска и тестирования:

1. ✅ Убедитесь, что все действия в боте генерируют события
2. ✅ Проверьте логи на отсутствие ошибок
3. 🚧 Интегрируйте реальный Auction Service
4. 🚧 Добавить обработку большего числа событий из NATS
5. 🚧 Переведите на webhook режим для production

## Полезные ссылки

- [Документация NATS](https://docs.nats.io/)
- [Документация Teloxide](https://docs.rs/teloxide)
- [Документация `dptree`](https://docs.rs/dptree)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)

