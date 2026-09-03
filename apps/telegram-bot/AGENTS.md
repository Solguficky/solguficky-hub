# Telegram Bot

TypeScript + grammY. Устройство — [ADR-030](../../docs/decisions/ADR-030-telegram-bot.md) и [бриф](../../docs/services/telegram-bot.md). Языковые правила — `proj-write-typescript`, граница Telegram — `proj-write-grammy-bot`.

- `src/presentation/` знает grammY, Bot API и Zod-разбор update.
- `src/application/` принимает установленную личность и намерение. Типы Telegram сюда не входят.
- Недоверенный ввод разбирается Zod на границе представления; `z.infer` даёт тип.
- Клиент Identity живёт в `src/identity/` и вызывается из представления до диспетчера.
- Конфигурация стека — `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`. Команды — `just telegram-bot-*`.
