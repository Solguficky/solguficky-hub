# Telegram Bot

TypeScript + grammY. Устройство — [ADR-030](../../docs/decisions/ADR-030-telegram-bot.md) и [бриф](../../docs/services/telegram-bot.md). Языковые правила — `proj-write-typescript`, граница Telegram — `proj-write-grammy-bot`.

- `src/presentation/` знает grammY, Bot API и Zod-разбор update.
- `src/application/` принимает установленную личность и намерение. Типы Telegram сюда не входят.
- Недоверенный ввод разбирается Zod на границе представления; `z.infer` даёт тип.
- Клиент Identity живёт в `src/identity/` и вызывается из представления до диспетчера.
- Конфигурация стека — `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`. Команды — `just telegram-bot-*`.
- `testkit/` — харнесс бота без Telegram и провод до настоящих Identity и Meetups. Его зовут `bot.test.ts` (L0) и сценарии `tests/contour/bot-wire` (L2, `vitest.contour.config.ts`, `just contour-bot-test`). Сценарии импортируют только `testkit/index.ts` относительным путём: голые импорты из `tests/` не резолвятся, и поэтому же сценарий не видит структур Telegram. Тем же путём ходит живой контур `tests/telegram-live` (L3, `vitest.live.config.ts`, `just telegram-live-test`): его зависимость mtcute лежит в собственном `package.json` каталога, а L0-тесты его классификатора отказов входят в `vitest.config.ts`. Ради этих каталогов `tsconfig.json` держит `rootDir: "../.."`, а `tsconfig.build.json` возвращает сборке `rootDir: "."` и свой `include`.
- Каталог `tests/contour/bot-wire/explore/` — исследующий прогон, а не сценарии: его гоняет свой `vitest.explore.config.ts` (`just contour-bot-explore`), а `vitest.contour.config.ts` исключает его явно. Он не гейт и в `verify`, `test-all` и CI не входит; `Person.pressable()`, геттер `records` у `openBotWire` и экспорт `failureCategories`/`LogRecord` из `testkit/index.ts` существуют ради него.
- Каталог `tests/contour/bot-wire/console/` — пульт провода по шагу, тоже не набор: его гоняет `vitest.console.config.ts` (`just contour-bot-console`), `vitest.contour.config.ts` исключает каталог, а L0-тесты разбора команд входят в `vitest.config.ts`. `Person.history()` и экспорт `ScreenView` существуют ради него.
- Каталог `tests/telegram-live/console/` — живой пульт L3, тоже не набор: его гоняет `vitest.live-console.config.ts` (`just telegram-live-console`), а `vitest.live.config.ts` берёт только `*.live.test.ts`. Его L0-тесты разбора команд и модели экранов входят в `vitest.config.ts` вместе с остальными `tests/telegram-live/**/*.test.ts`. Соединение с тестовой средой он берёт из `openLiveClient` драйвера, а не заводит своё.
