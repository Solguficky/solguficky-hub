# Auction Bot

Публичный вход в аукцион: отдельный процесс grammY со своим токеном и long polling. Устройство — [ADR-044](../../docs/decisions/ADR-044-two-telegram-bots-and-shared-auction-screens.md), [ADR-030](../../docs/decisions/ADR-030-telegram-bot.md) и [бриф ботов](../../docs/services/telegram-bot.md). Языковые правила — `proj-write-typescript`, граница Telegram — `proj-write-grammy-bot`. Команды — `just auction-bot-*`.

- `src/main.ts` — composition root: конфигурация, клиенты Identity и Auction, поллер и его остановка. Бот хаба — другой процесс: ни исходников, ни переменных `TELEGRAM_BOT_*` этот компонент не берёт.
- `src/bot.ts` — адаптер grammY, единственное место, где есть Telegram. Бот отвечает только в личном чате.
- `src/route.ts` — нажатие кнопки без Telegram: разрешает личность один раз на update и отдаёт её в `handleAuctionUpdate` поверхности `auction`. Identity или Auction недоступны — fail-closed.
- `src/entry-screen.ts` — оболочка `AuctionEntryScreen` и её перевод в текст и клавиатуру. Тексты принадлежат этому боту и с хабом не делятся.
- `src/clients.ts` — gRPC-клиенты в форме портов общего пакета. Порты собираются на каждый update, чтобы `request_id` уехал заголовком `x-request-id`; токен вызывающего ставит транспорт.
- Общий пакет `@solguficky/auction-bot-ui` — `file:`-зависимость на `shared/typescript/auction-bot-ui`. Его `exports` ведут в `dist`, поэтому рецепты сначала собирают пакет, а `prestart` — его `npm install` и сборку. Импорт только по имени пакета: относительный путь к его исходникам обходит границу `exports`.
- `gen/` — сгенерированный код `identity.v1` и `auction.v1` (`buf.gen.yaml`), в Git не лежит.

## Границы

- `/start` пока отвечает оболочкой без торговых экранов. Самозапись `public` на `/start` — PER-316, правила и помощь — PER-294, каталог и карточка — PER-306.
- Maintainer-секрет Identity бот не получает (ADR-044).
- Своего хранилища нет: состояние экрана живёт в `callback_data` (ADR-030).
- Telemetry по OTLP у бота пока нет: записи идут JSON-строкой в stdout.
