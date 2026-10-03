import { InlineKeyboard } from "grammy";
import type { CommunityDay } from "../../community-time.js";

// Словарь и сборщики экранов по дизайн-коду (docs/design/bot/design-code.md).
// Экран собирается из трёх частей: жирный заголовок, абзацы и клавиатура с
// рядом навигации в конце. Слова здесь закрыты: новое слово для той же
// функции не заводится, и линтер test kit держит это правило.

export const menuLabel = "Меню";
export const retryLabel = "Повторить";
export const cancelLabel = "Отмена";
export const noLabel = "Нет";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Заголовок экрана: жирная первая строка. Текст экранируется. */
export function heading(title: string): string {
  return `<b>${escapeHtml(title)}</b>`;
}

/** Текст экрана: заголовок и абзацы через пустую строку; пустые выпадают. */
export function screenText(
  title: string,
  ...paragraphs: (string | undefined)[]
): string {
  return [
    heading(title),
    ...paragraphs.filter(
      (paragraph): paragraph is string =>
        paragraph !== undefined && paragraph !== "",
    ),
  ].join("\n\n");
}

/**
 * Кадр отказа: первое предложение жирным вместо заголовка. Тексты кадров
 * ошибок по смыслу не меняются, поэтому свой заголовок им не придумывается.
 */
export function refusalText(text: string): string {
  const end = text.search(/[.?!](\s|$)/);
  if (end === -1) return heading(text);
  return `${heading(text.slice(0, end + 1))}${escapeHtml(text.slice(end + 1))}`;
}

/** Куда ведёт возврат: короткое имя родителя и данные его кнопки. */
export type Parent = { name: string; data: string };

export const toMenu: Parent = { name: menuLabel, data: "v1:nav:start" };
export const toUpcoming: Parent = { name: "Ближайшие", data: "v1:nav:hub" };
export const toArchive: Parent = { name: "Архив", data: "v1:nav:archive" };
export const toManage: Parent = { name: "Управление", data: "v1:manage:menu" };
export const toHidden: Parent = { name: "Скрытые", data: "v1:manage:hidden" };
export const toCommunity: Parent = {
  name: "Состав",
  data: "v1:community:list",
};

export function toCard(token: string): Parent {
  return { name: "Сходка", data: `v1:view:${token}` };
}

export function toMaterials(token: string): Parent {
  return { name: "Материалы", data: `v1:mm:list:${token}` };
}

/**
 * Начинает новый ряд, если текущий не пуст. `row()` у grammY добавляет ряд
 * всегда, и повторный вызов оставил бы в клавиатуре пустой ряд.
 */
export function nextRow(keyboard: InlineKeyboard): InlineKeyboard {
  return (keyboard.inline_keyboard.at(-1)?.length ?? 0) > 0
    ? keyboard.row()
    : keyboard;
}

export function backLabel(parent: Parent): string {
  return `‹ ${parent.name}`;
}

/**
 * Последний ряд экрана: `[‹ Родитель] [Меню]`. У детей меню родитель и есть
 * меню, поэтому кнопка одна.
 */
export function withNav(
  keyboard: InlineKeyboard,
  parent: Parent,
): InlineKeyboard {
  nextRow(keyboard).text(backLabel(parent), parent.data);
  if (parent.data !== toMenu.data) {
    keyboard.text(menuLabel, toMenu.data);
  }
  return keyboard;
}

/** Выход из кадра отказа, у которого родителя нет: только «Меню». */
export function menuOnly(keyboard = new InlineKeyboard()): InlineKeyboard {
  return nextRow(keyboard).text(menuLabel, toMenu.data);
}

/**
 * Клавиатура подтверждения: «Да, <глагол>» и «Нет» двумя рядами, без ряда
 * навигации. `danger` красит подтверждение действия, которое человек не
 * отменит с того же экрана; ссылка на источник, если она есть, идёт первой.
 */
export function confirmKeyboard(confirm: {
  yes: string;
  yesData: string;
  noData: string;
  danger?: boolean;
  lead?: { text: string; url: string };
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (confirm.lead !== undefined) {
    keyboard.url(confirm.lead.text, confirm.lead.url).row();
  }
  keyboard.text(confirm.yes, confirm.yesData);
  // Стиль grammY ставит на последнюю добавленную кнопку.
  if (confirm.danger === true) keyboard.danger();
  return keyboard.row().text(noLabel, confirm.noData);
}

/** Сколько строк содержимого помещается на страницу списка. */
export const pageSize = 8;

export type Page<T> = {
  items: readonly T[];
  /** Номер страницы с нуля, уже приведённый в диапазон. */
  page: number;
  pageCount: number;
};

/**
 * Режет полный список на страницы. Страница за пределами списка открывает
 * последнюю: кнопка листания могла остаться от более длинного списка.
 */
export function paginate<T>(all: readonly T[], requested: number): Page<T> {
  const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
  const page = Math.min(Math.max(requested, 0), pageCount - 1);
  return {
    items: all.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pageCount,
  };
}

/** Заголовок с номером страницы: «Архив · 2 из 5»; одна страница — без номера. */
export function pagedTitle(
  title: string,
  { page, pageCount }: Page<unknown>,
): string {
  return pageCount === 1 ? title : `${title} · ${page + 1} из ${pageCount}`;
}

/** Ряд листания; у единственной страницы его нет. */
export function withPager(
  keyboard: InlineKeyboard,
  { page, pageCount }: Page<unknown>,
  data: (page: number) => string,
): InlineKeyboard {
  if (pageCount === 1) return keyboard;
  nextRow(keyboard);
  if (page > 0) keyboard.text("←", data(page - 1));
  if (page + 1 < pageCount) keyboard.text("→", data(page + 1));
  return keyboard;
}

const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const weekdayFormat = new Intl.DateTimeFormat("ru-RU", {
  weekday: "short",
  timeZone: "UTC",
});

function utcDate(day: CommunityDay): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

/** «12 июня»: день и месяц в родительном падеже; чужой год называется. */
export function dayLabel(day: CommunityDay, today: CommunityDay): string {
  const label = dayFormat.format(utcDate(day));
  return day.year === today.year ? label : `${label} ${day.year}`;
}

/** «12 июня, сб» — дата для чтения в строке списка. */
export function readableDay(day: CommunityDay, today: CommunityDay): string {
  return `${dayLabel(day, today)}, ${weekdayFormat.format(utcDate(day))}`;
}

/** «12 июня, сб, 19:00» — дата и время для чтения. */
export function readableMoment(
  moment: CommunityDay & { hours: number; minutes: number },
  today: CommunityDay,
): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${readableDay(moment, today)}, ${pad(moment.hours)}:${pad(moment.minutes)}`;
}

/** Подпись переключателя: состояние словом в начале. */
export function toggleLabel(label: string, enabled: boolean): string {
  return `${enabled ? "Вкл" : "Выкл"} · ${label}`;
}

/** Подпись кнопки не длиннее того, что Telegram покажет без обрыва на байтах. */
export function buttonText(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}…`;
}
