import type { BotCommand } from "../../../core/menu-commands.js";

// Команды кнопки меню клиента — постоянный вход: `/menu` открывает корневое
// меню, общего родителя разделов, а команда раздела — сам раздел (PER-592;
// пересматривает решение владельца 10 октября 2026 года). Состав записан в
// брифе бота, раздел «Меню команд».
//
// `/start` в списке нет: его читают как команду первого запуска (PER-401).

const menu = { command: "menu", description: "Меню" } as const;
const meetups = { command: "meetups", description: "Сходки" } as const;
const next = { command: "next", description: "Ближайшая сходка" } as const;
const settings = { command: "settings", description: "Настройки" } as const;
const manage = { command: "manage", description: "Управление" } as const;
const help = { command: "help", description: "Помощь" } as const;

/** Общий список личных чатов: его видит каждый. */
export const botCommands = [
  menu,
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
  menu,
  meetups,
  next,
  settings,
  manage,
  help,
] as const satisfies readonly BotCommand[];
