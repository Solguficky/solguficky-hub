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
// «События» — в списке всегда (PER-669): без идущих событий команда открывает
// раздел с пустым состоянием, а кнопки в меню нет.
const events = { command: "events", description: "События" } as const;
const settings = { command: "settings", description: "Настройки" } as const;
const manage = { command: "manage", description: "Управление" } as const;
const help = { command: "help", description: "Помощь" } as const;

/** Общий список личных чатов: его видит каждый. */
export const botCommands = [
  menu,
  meetups,
  next,
  events,
  settings,
  help,
] as const satisfies readonly BotCommand[];

/**
 * Невидимые команды чата сообщества (ADR-078; развилка D-2 плана эпика
 * PER-679): команду и ответ на неё видит только отправитель. Сходки и события —
 * те же команды, что в личке (PER-683, PER-884); «События» — всегда, с
 * Auction и без него, как в личке (PER-669). Лота финала нет: `/lot` отложена
 * (PER-685; дополнение ADR-078 от 2026-11-19) и вернётся записью сюда и в
 * реестр шёпота. `/attach` — прикрепить ссылку на сообщение чата к сходке
 * (PER-885): своей команды в личке у неё нет, там материал прикрепляется из
 * карточки.
 */
export const communityChatCommands = [
  { ...meetups, is_ephemeral: true },
  { ...events, is_ephemeral: true },
  {
    command: "attach",
    description: "Прикрепить к сходке: /attach ссылка название",
    is_ephemeral: true,
  },
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
  events,
  settings,
  manage,
  help,
] as const satisfies readonly BotCommand[];
