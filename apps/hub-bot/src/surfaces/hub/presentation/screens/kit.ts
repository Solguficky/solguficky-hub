import { InlineKeyboard } from "grammy";
import { encodeAuctionCallback } from "../../../../auction-ui/index.js";
import { menuTitle } from "../../../../core/entry.js";
import {
  adminLabel,
  confirmNoLabel,
  confirmYesPrefix,
  marked,
  pictogram,
} from "../../../../core/pictograms.js";
import type { CommunityDay } from "../../community-time.js";

// Словарь и сборщики экранов по дизайн-коду (docs/design/bot/design-code.md).
// Экран собирается из трёх частей: жирный заголовок, абзацы и клавиатура с
// рядом навигации в конце. Слова здесь закрыты: новое слово для той же
// функции не заводится, и линтер test kit держит это правило.

export const retryLabel = "Повторить";
export const cancelLabel = "Отмена";
export const noLabel = confirmNoLabel;

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
 * Подменю сходки (PER-644; порядок строк по решению владельца от 16 октября
 * 2026 года): заголовок — имя подменю, как у любого экрана, а то, к чему оно
 * относится, — название сходки — строкой ниже курсивом, затем абзацы через
 * пустую строку. Так заголовок называет экран, а человек видит, в какой он
 * сходке.
 */
export function submenuText(
  submenu: string,
  meetupTitle: string,
  ...paragraphs: (string | undefined)[]
): string {
  return [
    `${heading(submenu)}\n<i>${escapeHtml(meetupTitle)}</i>`,
    ...paragraphs.filter(
      (paragraph): paragraph is string =>
        paragraph !== undefined && paragraph !== "",
    ),
  ].join("\n\n");
}

/** Строка списка в теле: маркер, затем поля (дизайн-код, «Формат»). */
export function bullet(line: string): string {
  return `• ${line}`;
}

/**
 * Экран исхода (дизайн-код, «Экран исхода», PER-472): исход действия — свой
 * экран, а не строка над карточкой. Первое предложение исхода — заголовок без
 * точки, под ним предмет жирным, затем остаток исхода абзацем. Карточку
 * открывает возврат: исход и содержимое не смешиваются.
 */
export function outcomeText(outcome: string, subject?: string): string {
  const end = outcome.search(/[.?!](\s|$)/);
  const sentence = end === -1 ? outcome : outcome.slice(0, end + 1);
  const title = sentence.endsWith(".") ? sentence.slice(0, -1) : sentence;
  const rest = end === -1 ? "" : outcome.slice(end + 1).trim();
  return screenText(
    title,
    subject === undefined || subject.trim() === ""
      ? undefined
      : subjectLine(subject),
    rest === "" ? undefined : escapeHtml(rest),
  );
}

/**
 * Предмет экрана — название сходки, лота, материала или имя человека абзацем
 * под заголовком — жирным и без кавычек (дизайн-код, «Формат»; PER-594).
 * Внутри фразы название по-прежнему стоит в кавычках.
 */
export function subjectLine(subject: string): string {
  return `<b>${escapeHtml(subject.replace(/\s+/g, " ").trim())}</b>`;
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

/**
 * Корневое меню — общий родитель разделов (PER-592; пересматривает решение
 * владельца 10 октября 2026 года). Кнопка старая — `v1:nav:start`: прежние
 * кнопки «Меню» в чатах ведут туда же.
 */
export const toMenu: Parent = { name: menuTitle, data: "v1:nav:start" };

/**
 * Корень основного раздела — «Сходки». Кадры отказа и устаревшие экраны
 * возвращают сюда: это ближайший живой экран (дизайн-код, «Навигация»).
 */
export const toMeetups: Parent = { name: "Сходки", data: "v1:nav:hub" };
export const toArchive: Parent = { name: "Архив", data: "v1:nav:archive" };
export const toSettings: Parent = {
  name: "Настройки",
  data: "v1:nav:settings",
};
/**
 * Вход в вопрос о новом лоте: в ленте и на исходе «Аукцион включён». Знак
 * управления — 🛠 (PER-669): экраны аукциона видит и участник.
 */
export const addLotLabel = adminLabel("Добавить лот");

export const toManage: Parent = { name: "Управление", data: "v1:manage:menu" };
export const toHidden: Parent = { name: "Скрытые", data: "v1:manage:hidden" };
export const toSourceChannels: Parent = { name: "Каналы", data: "v1:sc:l" };
export const toCommunity: Parent = {
  name: "Состав",
  data: "v1:community:list",
};

export function toCard(token: string): Parent {
  return { name: "Сходка", data: `v1:view:${token}` };
}

/**
 * Меню «Расширения» сходки (PER-605): вход в расширения с карточки. Данные —
 * токен сходки, 29 байт.
 */
export function extensionsData(meetupToken: string): string {
  return `v1:ext:${meetupToken}`;
}

export function toExtensions(meetupToken: string): Parent {
  return { name: "Расширения", data: extensionsData(meetupToken) };
}

/** Корень аукциона — тело аукционного дерева (PER-605). */
export function auctionRootData(auctionId: string): string {
  return encodeAuctionCallback({ kind: "root", auctionId });
}

/** Раздел «События» (PER-669): идущие события расширений сходок. */
export const toEvents: Parent = { name: "События", data: "v1:nav:events" };

// Вход в аукционное дерево (PER-669): из «Событий» кнопки аукциона несут
// домен `aue` вместо `auc`, той же длины, и корень возвращает в «События», а не
// в «Расширения» сходки. Дерево о входе не знает: хаб снимает отметку перед
// шлюзом и ставит её на кнопки готового экрана, поэтому байтов у кнопок не
// прибавляется и ставка с подтверждением вход тоже сохраняет.
const treePrefix = "v1:auc:";
const eventsPrefix = "v1:aue:";
export const eventsEntryDomain = "aue";
export type AuctionEntry = "meetup" | "events";

/** Кнопка аукционного дерева со входом из «Событий». */
export function viaEvents(data: string): string {
  return data.startsWith(treePrefix)
    ? `${eventsPrefix}${data.slice(treePrefix.length)}`
    : data;
}

/** Данные дерева без отметки входа и сам вход. */
export function auctionEntryOf(data: string): {
  data: string;
  entry: AuctionEntry;
} {
  return data.startsWith(eventsPrefix)
    ? {
        data: `${treePrefix}${data.slice(eventsPrefix.length)}`,
        entry: "events",
      }
    : { data, entry: "meetup" };
}

/** Все кнопки дерева на клавиатуре — со входом из «Событий». */
export function keyboardViaEvents(keyboard: InlineKeyboard): InlineKeyboard {
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      if ("callback_data" in button && button.callback_data !== undefined) {
        button.callback_data = viaEvents(button.callback_data);
      }
    }
  }
  return keyboard;
}

/** Возврат в корень аукциона: ему хватает идентификатора аукциона. */
export function toAuctionRoot(auctionId: string): Parent {
  return { name: "Аукцион", data: auctionRootData(auctionId) };
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
 * Последний ряд экрана — одна кнопка `[‹ Родитель]`; корни разделов
 * возвращают `[‹ Меню]` (PER-592).
 */
export function withNav(
  keyboard: InlineKeyboard,
  parent: Parent,
): InlineKeyboard {
  nextRow(keyboard).text(backLabel(parent), parent.data);
  return keyboard;
}

/**
 * Выход кадра, у которого родителя нет, — отказа, устаревшего экрана: возврат
 * в корень основного раздела «‹ Сходки».
 */
export function exitToMeetups(keyboard = new InlineKeyboard()): InlineKeyboard {
  return withNav(keyboard, toMeetups);
}

/**
 * Клавиатура подтверждения: `[✔️ Да, <глагол>] [✖️ Нет]` одним рядом, без ряда
 * навигации (решение владельца 10 октября 2026 года). `yes` — слова «Да, …»
 * без знака: знак ставит сборщик. `irreversible` — после «Да» обратного
 * действия нет или тратятся деньги: только такое «Да» красится `danger`, и
 * красится обязательно; обратимое подтверждение цвета не несёт.
 * Ссылка на источник, если она есть, идёт первым рядом.
 */
export function confirmKeyboard(confirm: {
  yes: string;
  yesData: string;
  noData: string;
  irreversible?: boolean;
  lead?: { text: string; url: string };
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (confirm.lead !== undefined) {
    keyboard.url(confirm.lead.text, confirm.lead.url).row();
  }
  keyboard.text(confirmYesLabel(confirm.yes), confirm.yesData);
  // Стиль grammY ставит на последнюю добавленную кнопку.
  if (confirm.irreversible === true) keyboard.danger();
  return keyboard.text(noLabel, confirm.noData);
}

/** Подпись «Да» подтверждения: «Да, …» со знаком словаря впереди. */
export function confirmYesLabel(yes: string): string {
  return yes.startsWith(confirmYesPrefix) ? yes : marked(pictogram.yes, yes);
}

/** Подпись кнопки, ведущей к удалению: «🗑 Убрать», «🗑 Удалить аукцион». */
export function removeLabel(words: string): string {
  return marked(pictogram.remove, words);
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

/**
 * Подпись переключателя уведомлений: колокольчик словаря перед состоянием —
 * «🔔 Вкл · Новые сходки», «🔕 Выкл · Объявления сообщества».
 */
export function notificationToggleLabel(
  label: string,
  enabled: boolean,
): string {
  return marked(
    enabled ? pictogram.on : pictogram.off,
    toggleLabel(label, enabled),
  );
}

/** Подпись кнопки не длиннее того, что Telegram покажет без обрыва на байтах. */
export function buttonText(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}…`;
}

/** Число со словом в нужной форме: «1 лот», «3 лота», «5 лотов». */
export function plural(count: number, forms: [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;
  const form =
    tens >= 11 && tens <= 14
      ? forms[2]
      : ones === 1
        ? forms[0]
        : ones >= 2 && ones <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}
