import type { BotCommand } from "../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход и дорога между разделами:
// корневого экрана «Меню» нет, «Аукционы», «Прошедшие», FAQ и, у бота с
// Notifications, «Избранное» (PER-495) и «Уведомления» (PER-515) — корни, и
// каждая команда открывает свой (решение владельца 10 октября 2026 года).
// `/start` в списке нет: его читают как команду первого запуска (PER-472).
// `/menu` из списка убран, но разбирается как `/auctions` — по старой привычке.
export const botCommands = [
  { command: "auctions", description: "Аукционы" },
  { command: "past", description: "Прошедшие" },
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
