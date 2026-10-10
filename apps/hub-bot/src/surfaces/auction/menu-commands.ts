import type { BotCommand } from "../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход и дорога между разделами:
// корневого экрана «Меню» нет, «Аукционы», «Прошедшие» и FAQ — корни, и каждая
// команда открывает свой (решение владельца 10 октября 2026 года). `/start` в
// списке нет: его читают как команду первого запуска (PER-472). `/menu` из
// списка убран, но разбирается как `/auctions` — по старой привычке.
export const botCommands = [
  { command: "auctions", description: "Аукционы" },
  { command: "past", description: "Прошедшие" },
  { command: "faq", description: "Правила и FAQ" },
] as const satisfies readonly BotCommand[];
