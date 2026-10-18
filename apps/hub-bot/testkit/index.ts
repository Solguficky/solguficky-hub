// Вход test kit пакета ботов — обеих поверхностей — для наборов вне
// компонента: сценариев провода и пульта. Они импортируют только этот модуль
// относительным путём: голые импорты оттуда не резолвятся, потому что
// зависимости стоят в `apps/hub-bot/node_modules`. Поэтому же vitest
// отдаётся отсюда, а `grammy` — нет: сценарий L2 не видит структур Telegram по
// построению, а не по договорённости.
export { afterAll, beforeAll, describe, expect, it } from "vitest";
// Словарь категорий отказа и форма записи лога — для оракулов исследующего
// прогона (`explore/`): словарь один, копия в наборе разошлась бы молча.
export { failureCategories } from "../src/core/failures.js";
// Провод поверхности аукциона: тот же kit, бот — свой.
export {
  type AuctionContourEnvironment,
  openAuctionBotWire,
  readAuctionContourEnvironment,
} from "./auction-contour.js";
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
export {
  auctionBotInfo,
  botInfo,
  type LogRecord,
  type RecordedCall,
} from "./harness.js";
// Линтер экрана: набор на контуре снимает найденное сам, пульт показывает его
// в ответе на действие.
export { type ScreenViolation, takeViolations } from "./screen-lint.js";
