// Вход test kit бота для наборов вне компонента. Сценарий в `tests/` импортирует
// только этот модуль относительным путём: голые импорты оттуда не резолвятся,
// потому что зависимости стоят в `apps/hub-bot/node_modules`. Поэтому же
// vitest отдаётся отсюда, а `grammy` — нет: сценарий L2 не видит структур
// Telegram по построению, а не по договорённости.
export { afterAll, beforeAll, describe, expect, it } from "vitest";
// Словарь категорий отказа и форма записи лога — для оракулов исследующего
// прогона (`explore/`): словарь один, копия в наборе разошлась бы молча.
export { failureCategories } from "../src/failures.js";
export {
  type AuthorJournal,
  type ContourEnvironment,
  freshTelegramUserId,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
  unreachableUrl,
  unusedMeetupId,
  usernameFor,
} from "./contour.js";
export {
  type ButtonView,
  meetupIdFromStartLink,
  type Person,
  type PhotoVariant,
  photoVariants,
  type ScreenView,
  startConversation,
} from "./conversation.js";
export type { LogRecord } from "./harness.js";
// Линтер экрана: набор на контуре снимает найденное сам, пульт показывает его
// в ответе на действие.
export { type ScreenViolation, takeViolations } from "./screen-lint.js";
