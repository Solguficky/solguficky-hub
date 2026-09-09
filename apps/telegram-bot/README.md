# Telegram Bot

Первый TypeScript-компонент платформы. Принимает `/start` в личном чате, разрешает личность через Identity, показывает полученный из Meetups список видимых сходок и ведёт форму создания сходки, сохраняя каждый шаг в Meetups. Список разделяет сходки с датой и без неё; пустой ответ и недоступность Meetups показаны разными экранами.

Сгенерированный контракт Identity лежит в `gen/` и в Git не хранится. Команда сборки сначала вызывает `buf generate`.

## Команды

Из корня репозитория:

```bash
just telegram-bot-tools
just telegram-bot-proto
just telegram-bot-build
just telegram-bot-typecheck
just telegram-bot-test
just telegram-bot-lint
just telegram-bot-run
```

`just telegram-bot-tools` ставит зависимости через `npm ci`. Без него кодогенерация не находит `protoc-gen-es`.

Токен бота — `TELEGRAM_BOT_TOKEN` (обязателен для процесса). Адрес Identity — `IDENTITY_GRPC_URL`, по умолчанию `http://127.0.0.1:50051`; адрес Meetups — `MEETUPS_GRPC_URL`, по умолчанию `http://127.0.0.1:50052`. Уровень лога — `TELEGRAM_BOT_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`).

Тесты не ходят в Telegram и не требуют токена.

## Раскладка

- `src/presentation/` — grammY, разбор update, Zod-схемы недоверенного ввода.
- `src/application/` — диспетчер и юзкейсы. Сюда не импортируют `grammy`.
- `src/identity/` — клиент `ResolveIdentity` через Connect gRPC.
- `src/meetups/` — клиент команд формы и `ListVisibleMeetups` через Connect gRPC.
