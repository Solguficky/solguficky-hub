import type { BotCommand } from "../../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход и дорога между разделами:
// корневого экрана «Меню» нет, каждая команда открывает корень своего раздела
// (решение владельца 10 октября 2026 года; отменяет «в меню одна команда
// /menu» PER-468). Состав записан в брифе бота, раздел «Меню команд».
//
// `/start` в списке нет: его читают как команду первого запуска (PER-401).
// `/menu` из списка убран, но разбирается как `/meetups` — по старой привычке.

const meetups = { command: "meetups", description: "Сходки" } as const;
const next = { command: "next", description: "Ближайшая сходка" } as const;
const settings = { command: "settings", description: "Настройки" } as const;
const manage = { command: "manage", description: "Управление" } as const;
const help = { command: "help", description: "Помощь" } as const;

/** Общий список личных чатов: его видит каждый. */
export const botCommands = [
  meetups,
  next,
  settings,
  help,
] as const satisfies readonly BotCommand[];

/**
 * Список чата держателя права управления: «Управление» стоит перед «Помощью».
 * Его ставит `/start` и сообщение о назначении администратором — список
 * администраторов живёт в Identity, и общий список на старте его не знает.
 */
export const managerCommands = [
  meetups,
  next,
  settings,
  manage,
  help,
] as const satisfies readonly BotCommand[];
