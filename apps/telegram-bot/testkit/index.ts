// Вход test kit бота для наборов вне компонента. Сценарий в `tests/` импортирует
// только этот модуль относительным путём: голые импорты оттуда не резолвятся,
// потому что зависимости стоят в `apps/telegram-bot/node_modules`. Поэтому же
// vitest отдаётся отсюда, а `grammy` — нет: сценарий L2 не видит структур
// Telegram по построению, а не по договорённости.
export { afterAll, beforeAll, describe, expect, it } from "vitest";
export {
  type ContourEnvironment,
  freshTelegramUserId,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
  unreachableUrl,
} from "./contour.js";
export {
  meetupIdFromStartLink,
  type Person,
  startConversation,
} from "./conversation.js";
