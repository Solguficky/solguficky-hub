import type {
  FeedItem,
  LotStanding,
  OwnDisplayName,
} from "./auction-ui/index.js";
import { money } from "./core/format.js";
import { marked, pictogram } from "./core/pictograms.js";

// Тексты участника аукциона, общие у обеих поверхностей (PER-595), как тексты
// розыгрыша: избранное, положение на лоте, сводка своих лотов над списком и
// имя в аукционе из настроек. Навигацию и экранирование названия задаёт
// оболочка.

export const followLabel = "Добавить в избранное";
export const unfollowLabel = "Убрать из избранного";

// Ставка кладёт лот в избранное сама, а снятый вручную лот не возвращает
// (ADR-063): человек узнаёт об этом на экране принятой ставки.
export const autoFollowNote =
  "Ставка сама добавляет лот в избранное. Лот, который ты оттуда убрал, она не вернёт.";

/** Строка карточки проданного лота у покупателя: «✅ Твой лот». */
export const ownLotLine = marked(pictogram.won, "Твой лот");

// Своих лотов в сводке над списком: остальные — кнопками, а сводка не
// должна вытеснить их с экрана телефона.
export const MINE_SHOWN = 8;

export type MineOptions = {
  // Название лота одной строкой, уже экранированное.
  title: (item: FeedItem) => string;
  // Цена или итог лота, как у строки ленты.
  price: (item: FeedItem) => string;
};

/** Строка своего лота: «Кружка — 1 200 ₽, ты лидер», «Ваза — ✅ твой лот за 2 000 ₽». */
export function mineLine(item: FeedItem, options: MineOptions): string {
  return `${options.title(item)} — ${standingText(item, options)}`;
}

function standingText(item: FeedItem, options: MineOptions): string {
  const standing: LotStanding | undefined = item.standing;
  if (standing === "won" && item.status.kind === "sold") {
    return `${marked(pictogram.won, "твой лот")} за ${money(item.status.price)}`;
  }
  return standing === "leader"
    ? `${options.price(item)}, ты лидер`
    : options.price(item);
}

/**
 * Абзацы сводки над лентой «Лоты» (PER-595): текст говорит, что в нём не все
 * лоты, а только свои — где смотрящий лидер или покупатель; все лоты — кнопки.
 * Лоты страницы, на которых действуют «Счастливые часы» (PER-505), сводка
 * называет отдельной строкой: строк лотов в теле больше нет, а кнопка короткая.
 */
export function feedSummary(
  mine: readonly FeedItem[],
  page: readonly FeedItem[],
  options: MineOptions,
): string[] {
  const happy = page.filter((item) => item.activeWindow !== undefined);
  const happyLine =
    happy.length === 0
      ? []
      : [`Счастливые часы сейчас: ${happy.map(options.title).join(", ")}.`];
  if (mine.length === 0) {
    return [
      "Ты пока не лидируешь ни в одном лоте этого аукциона. Все лоты — кнопками ниже.",
      ...happyLine,
    ];
  }
  return [
    "Здесь только твои лоты: где ты лидер и что ты купил. Все лоты аукциона — кнопками ниже.",
    mineLines(mine, options),
    ...happyLine,
  ];
}

/** Абзацы сводки над «Избранным»: сколько лотов, затем свои — как у ленты. */
export function favoritesSummary(
  total: number,
  mine: readonly FeedItem[],
  options: MineOptions,
): string[] {
  const count = `Лотов в избранном: ${total}.`;
  if (mine.length === 0) {
    return [
      `${count} Ты пока не лидируешь ни в одном из них. Все — кнопками ниже.`,
    ];
  }
  return [
    `${count} Списком — те, где ты лидер или что ты купил. Все избранные — кнопками ниже.`,
    mineLines(mine, options),
  ];
}

/** Пустое избранное: как его пополнить. */
export const favoritesEmpty = `Лотов в избранном пока нет. Отметь лот кнопкой «${followLabel}» на его карточке или сделай ставку — она добавит лот сама.`;

function mineLines(mine: readonly FeedItem[], options: MineOptions): string {
  const shown = mine.slice(0, MINE_SHOWN);
  const rest = mine.length - shown.length;
  return [
    ...shown.map((item) => `• ${mineLine(item, options)}`),
    ...(rest > 0 ? [`И ещё ${rest}.`] : []),
  ].join("\n");
}

/**
 * Строка лидера карточки. Имени нет, а лидер есть — Auction не отдал имя:
 * идентификатор вместо имени человеку не показывается. Лидер — сам
 * смотрящий: строка говорит «ты» (PER-595).
 */
export function leaderLine(
  leaderId: string | undefined,
  participantName: string | undefined,
  standing: LotStanding | undefined,
): string {
  if (leaderId === undefined) return "Лидер: пока нет";
  if (standing === "leader") {
    return participantName === undefined
      ? "Лидер: ты"
      : `Лидер: ты (${participantName})`;
  }
  return participantName === undefined
    ? "Лидер: есть"
    : `Лидер: ${participantName}`;
}

export const nameSettingsTitle = "Имя в аукционе";

/**
 * Абзацы экрана имени из настроек (PER-595), уже экранированные: имя видно
 * всем участникам и после первой ставки не меняется (ADR-059).
 */
export function nameSettingsParagraphs(
  name: OwnDisplayName | undefined,
  username: string | undefined,
): string[] {
  if (name?.frozen === true) {
    return [
      `Твоё имя: ${escapeHtml(name.text)}. Ты уже ставил в этом аукционе, и имя больше не меняется.`,
    ];
  }
  const choice =
    username === undefined
      ? "Ника в Telegram у тебя нет: возьми псевдоним."
      : `Можно ставить под ником @${escapeHtml(username)} или взять псевдоним.`;
  return [
    name === undefined
      ? "Имя видно всем участникам аукциона рядом с твоими ставками. Выбери его сейчас — или бот спросит перед первой ставкой. После первой ставки его не поменять."
      : `Твоё имя: ${escapeHtml(name.text)}. Его видят все участники рядом с твоими ставками. Поменять можно до первой ставки.`,
    choice,
  ];
}

/** Подпись текущего значения в вопросе суммы и лимита (PER-595). */
export function currentValueLine(
  current: { amount: string; limit: boolean } | undefined,
): string[] {
  if (current === undefined) return [];
  return [
    current.limit
      ? `Твой лимит сейчас: ${current.amount}`
      : `Минимальная ставка: ${current.amount}`,
  ];
}

/** Начало пояснения автоставки голосом помощника (PER-517, PER-595). */
export const proxyHintLead = `${marked(pictogram.hint, "Подсказка:")} платишь цену, а не лимит. Лимит — твой потолок: бот перебивает чужие ставки по шагу, пока не дойдёт до него.`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
