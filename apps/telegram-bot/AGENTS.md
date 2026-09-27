# Telegram Bot

TypeScript + grammY. Устройство — [ADR-030](../../docs/decisions/ADR-030-telegram-bot.md) и [бриф](../../docs/services/telegram-bot.md). Языковые правила — `proj-write-typescript`, граница Telegram — `proj-write-grammy-bot`.

- `src/presentation/` знает grammY, Bot API и Zod-разбор update.
- `src/application/` принимает установленную личность и намерение. Типы Telegram сюда не входят.
- Недоверенный ввод разбирается Zod на границе представления; `z.infer` даёт тип.
- Клиент Identity живёт в `src/identity/` и вызывается из представления до диспетчера.
- Конфигурация стека — `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`. Команды — `just telegram-bot-*`.
- `testkit/` — харнесс бота без Telegram и провод до настоящих Identity и Meetups. Его зовут `bot.test.ts` (L0) и сценарии `tests/contour/bot-wire` (L2, `vitest.contour.config.ts`, `just contour-bot-test`). Сценарии импортируют только `testkit/index.ts` относительным путём: голые импорты из `tests/` не резолвятся, и поэтому же сценарий не видит структур Telegram. Ради этого каталога `tsconfig.json` держит `rootDir: "../.."`, а `tsconfig.build.json` возвращает сборке `rootDir: "."` и свой `include`.
