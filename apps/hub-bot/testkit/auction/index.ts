// Вход test kit поверхности аукциона для пульта провода
// (`tests/contour/bot-wire/console`). Пульт импортирует только этот модуль
// относительным путём: зависимости стоят в `apps/hub-bot/node_modules`, и голый
// импорт из `tests/` не резолвится. Структур Telegram отсюда не выходит:
// разговор ведёт модель kit хаба по записи вызовов.
export {
  type AuctionContourEnvironment,
  openAuctionBotWire,
  readAuctionContourEnvironment,
} from "./contour.js";
export { botInfo, type LogRecord, type RecordedCall } from "./harness.js";
export { type ScreenViolation, takeViolations } from "./screen-lint.js";
