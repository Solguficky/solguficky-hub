# Solguficky Hub

Платформа для управления сходками с микросервисной архитектурой.

## 🚀 Быстрый старт

### Запуск Telegram Gateway (для разработки)

```bash
# 1. Клонировать репозиторий
git clone https://github.com/your-org/solguficky-hub.git
cd solguficky-hub

# 2. Настроить окружение
cp .env.example .env
# Отредактируйте .env и добавьте ваш Telegram bot token

# 3. Запустить инфраструктуру и сервис
docker-compose up --build

# 4. Написать боту /start в Telegram
```

Подробная инструкция: [services/telegram-gateway/LOCAL_SETUP.md](services/telegram-gateway/LOCAL_SETUP.md)

## 📚 Документация

- [Архитектура](docs/01_ARCHITECTURE/architechture.md) - общая архитектура платформы
- [Telegram Gateway](docs/02_SERVICES/telegram-gateway.md) - техническое задание
- [NATS контракты](docs/03_CONTRACTS/nats_subjects.md) - форматы сообщений
- [Архитектурные решения (ADR)](docs/04_DECISIONS/decisions.md) - ключевые технические решения

## 🏗️ Структура проекта

```
solguficky-hub/
├── contracts/          # Protobuf схемы для всех сервисов
│   └── proto/
├── docs/              # Документация
├── services/          # Микросервисы
│   ├── telegram-gateway/  # Rust - API Gateway для Telegram
│   ├── auction-service/   # Scala/Akka - Сервис аукционов (планируется)
│   └── ...
└── docker-compose.yml # Локальная инфраструктура
```

## 🛠️ Технологический стек

- **Telegram Gateway**: Rust + Teloxide + NATS + Protobuf
- **Auction Service**: Scala + Akka (Event Sourcing)
- **Notifications Service**: Elixir + Phoenix
- **Инфраструктура**: NATS JetStream, PostgreSQL, Apicurio Registry

## 📖 Дополнительная информация

См. [docs/00_VISION/vision.md](docs/00_VISION/vision.md) для понимания целей и концепции проекта.