# Solguficky Hub

Платформа для организации сходок Telegram-сообщества. Полиглотная микросервисная архитектура; одновременно — площадка для экспериментов и обучения.

## 🚀 Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone https://github.com/your-org/solguficky-hub.git
cd solguficky-hub

# 2. Настроить окружение
cp .env.example .env
# Отредактируйте .env и добавьте ваш Telegram bot token

# 3. Запустить инфраструктуру и сервисы
docker-compose up --build

# 4. Написать боту /start в Telegram
```

Подробные инструкции — в `LOCAL_SETUP.md` внутри каждого сервиса.

## 🏗️ Структура проекта

```
solguficky-hub/
├── contracts/proto/    # Protobuf-контракты (NATS + gRPC) — источник правды
├── docs/               # Контекст проекта, vision, архитектура, ADR и сервисные документы
├── services/
│   ├── telegram-gateway/      # Rust + Teloxide — входной шлюз, UI бота
│   ├── auction-service/       # C# + Akka.NET — legacy-прототип аукциона, не входит в MVP
│   ├── notifications-service/ # C# — события → уведомления
│   └── websocket-gateway/     # C# + SignalR — события NATS → WebSocket
├── tools/nats-tester/  # Python CLI для тестирования NATS-сообщений
├── frontend/admin-app/ # Telegram Mini App (не начато)
└── docker-compose.yml  # Локальная инфраструктура (PostgreSQL, NATS)
```

## 🛠️ Технологический стек

- **Шина:** NATS, сериализация — Protobuf; durable delivery и JetStream требуют отдельного решения
- **Синхронные вызовы:** gRPC
- **Хранение:** PostgreSQL (включая Event Store для Akka.Persistence)
- **Наблюдаемость:** структурные JSON-логи → Loki + Grafana (конфиги в `infra/`)

## 📚 Документация

- **[Контекст проекта](docs/PROJECT_CONTEXT.md)** — актуальный срез Current / MVP / Future / Legacy и статус открытых решений
- **[Канвас проекта](docs/canvas.html)** — архивный визуальный срез на 18.07.2026, не источник актуальных решений
- [Vision](docs/00_VISION/vision.md) — цели и концепция
- [Архитектура](docs/01_ARCHITECTURE/architecture.md) — общая схема платформы
- [ADR](docs/04_DECISIONS/decisions.md) — журнал архитектурных решений
- [NATS-контракты](docs/03_CONTRACTS/nats_subjects.md) — темы и форматы сообщений
- [AGENTS.md](AGENTS.md) — контекст для AI-агентов (карта репо, команды, конвенции). `CLAUDE.md` — просто импорт этого файла

Milestones, приоритеты, задачи и прогресс ведутся в Linear и не дублируются отдельным roadmap в Git.
