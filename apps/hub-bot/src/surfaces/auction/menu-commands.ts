import type { BotCommand } from "../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход (дизайн-код, «Навигация»).
// В меню возвращает `/menu`, как в боте хаба: `/start` читают как команду
// первого запуска, и в списке его нет (решение владельца 7 октября 2026 года,
// PER-472). Сам `/start` с кодом канала работает по-прежнему, а `/menu`
// разбирается как `/start` без кода. `/faq` открывает FAQ с любого места бота.
export const botCommands = [
  { command: "menu", description: "Меню аукциона" },
  { command: "faq", description: "Правила и FAQ" },
] as const satisfies readonly BotCommand[];
