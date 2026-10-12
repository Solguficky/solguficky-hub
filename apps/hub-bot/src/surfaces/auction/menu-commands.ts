import type { BotCommand } from "../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход: `/menu` открывает корневое
// меню, общего родителя разделов, а команда раздела — сам раздел: «Аукционы»
// с «Прошедшими» внутри, FAQ и, у бота с Notifications, «Избранное»
// (PER-495) и «Уведомления» (PER-515) (PER-592; пересматривает решение
// владельца 10 октября 2026 года). `/start` в списке нет: его читают как
// команду первого запуска (PER-472). `/past` из списка убран — прошедшие
// внутри «Аукционов», — но по старой привычке открывает их.
export const botCommands = [
  { command: "menu", description: "Меню" },
  { command: "auctions", description: "Аукционы" },
  { command: "faq", description: "Правила и FAQ" },
] as const satisfies readonly BotCommand[];

// Разделы, которым нужен Notifications: без него команда открыла бы кадр
// устаревшего экрана, поэтому в меню клиента её нет.
export const notificationsCommands = [
  { command: "favorites", description: "Избранное" },
  { command: "notifications", description: "Уведомления" },
] as const satisfies readonly BotCommand[];

/** Список команд кнопки меню клиента: с Notifications — и его разделы. */
export function commandsFor(withNotifications: boolean): readonly BotCommand[] {
  return withNotifications
    ? [
        ...botCommands.slice(0, 2),
        ...notificationsCommands,
        ...botCommands.slice(2),
      ]
    : botCommands;
}
