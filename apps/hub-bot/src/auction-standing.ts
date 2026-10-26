import type {
  BidExtension,
  BidOriginView,
  FeedItem,
  HistoryItem,
  LotStanding,
  LotStatusView,
  Money,
  OwnDisplayName,
} from "./auction-ui/index.js";
import { money, truncate } from "./core/format.js";
import { localTime } from "./core/notifications/lot-notice.js";
import { marked, pictogram } from "./core/pictograms.js";

// Тексты участника аукциона, общие у обеих поверхностей (PER-595), как тексты
// розыгрыша: избранное, положение на лоте, сводка своих лотов над списком и
// имя в аукционе из настроек. Навигацию и экранирование названия задаёт
// оболочка.

export const followLabel = "Добавить в избранное";
export const unfollowLabel = "Убрать из избранного";
/**
 * Листание лотов в карточке лота (PER-644): соседи в порядке ленты. Знак
 * листания свой и без слова (PER-669): «‹» остаётся только у возврата к
 * родителю, и ряд `[◀️][🔄 Обновить][▶️]` не читается как возврат.
 */
export const lotPrevLabel: string = pictogram.previous;
export const lotNextLabel: string = pictogram.next;
/** Вход в ленту из корня аукциона — со знаком раздела аукциона (PER-644). */
export const lotsLabel = marked(pictogram.auction, "Лоты");

// Ставка кладёт лот в избранное сама, а снятый вручную лот не возвращает
// (ADR-063): человек узнаёт об этом на экране принятой ставки.
export const autoFollowNote =
  "Ставка сама добавляет лот в избранное. Лот, который ты оттуда убрал, она не вернёт.";

/**
 * Лот в онлайн-торгах без лидера (PER-631, №82): ставок ещё нет, и первая
 * ставка — по порогу, а не «по шагу». После снятия участника, который никого
 * не оставил лидером, лот выглядит так же, и первая ставка — та же.
 */
export function awaitsFirstBid(status: LotStatusView): boolean {
  return (
    status.kind === "trading" &&
    status.phase === "online" &&
    status.leaderId === undefined
  );
}

/** Поле цены карточки лота в торгах: без ставок — «Стартовая цена» (№82). */
export function tradingPriceLine(
  status: Extract<LotStatusView, { kind: "trading" }>,
): string {
  return marked(
    pictogram.price,
    `${awaitsFirstBid(status) ? "Стартовая цена" : "Цена"}: ${money(status.currentPrice)}`,
  );
}

/** Кнопка ставки по порогу: «Первая ставка (1 000 ₽)» или «По шагу (1 050 ₽)». */
export function stepBidLabel(amount: Money, firstBid: boolean): string {
  return `${firstBid ? "Первая ставка" : "По шагу"} (${money(amount)})`;
}

/**
 * Свой лимит на карточке. Лимит ниже порога следующей ставки у не-лидера
 * больше ничего не сделает (PER-631, №81): строка говорит, что он исчерпан.
 * В живом финале (PER-713) кнопки «Автоставка» нет, поэтому поднять лимит
 * строка не советует, а лидеру, который поставил выше своего лимита рукой,
 * лимит ниже текущей цены тоже показан исчерпанным, а не действующим.
 * Онлайн-неделя показывает лимит лидера как раньше.
 */
export function ownProxyLine(lot: {
  viewerProxyLimit: Money;
  nextPrice?: Money;
  standing?: LotStanding;
  status: LotStatusView;
}): string {
  const limit = lot.viewerProxyLimit;
  const { status } = lot;
  const live = status.kind === "trading" && status.phase === "live";
  const below = (threshold: Money | undefined) =>
    threshold !== undefined &&
    threshold.currency === limit.currency &&
    limit.minorUnits < threshold.minorUnits;
  const exhausted =
    lot.standing !== "leader"
      ? below(lot.nextPrice)
      : status.kind === "trading" && live && below(status.currentPrice);
  if (!exhausted) {
    return `Твоя автоставка: до ${money(limit)} (видишь только ты)`;
  }
  return live
    ? `Автоставка до ${money(limit)} исчерпана`
    : `Автоставка до ${money(limit)} исчерпана — подними лимит`;
}

/**
 * Строка анти-снайпа на экране принятой ставки (PER-631, №107): «Торги
 * продлены до 11:03 (продление 3 из 3).» или, когда продления кончились,
 * «Продлений больше не будет: торги закроются в 11:03.» Строка не говорит, что
 * продлила именно эта ставка: между командой и перечитыванием лота торги могла
 * продлить и чужая ставка, а версия чтения — порог, а не точная версия
 * команды. Время — по часам сообщества; непрочитанный момент строку убирает.
 */
export function extensionLine(
  extension: BidExtension,
  timeZone: string,
): string | undefined {
  const at = localTime(extension.deadline, timeZone);
  if (at === undefined) return undefined;
  return extension.kind === "exhausted"
    ? `Продлений больше не будет: торги закроются в ${at}.`
    : `Торги продлены до ${at} (продление ${extension.used} из ${extension.max}).`;
}

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
 * До торгов лидерства нет ни у кого, и сводка говорит, что торги не начались
 * (PER-618).
 */
export function feedSummary(
  feed: {
    lots: readonly FeedItem[];
    mine?: readonly FeedItem[];
    beforeTrading?: true;
    final?: { active?: FeedItem };
  },
  options: MineOptions,
): string[] {
  if (feed.beforeTrading === true) return [beforeTradingLine];
  const mine = feed.mine ?? [];
  // В живом финале сводка начинается с того, что идёт в зале (PER-639), а
  // «не лидируешь» не говорит: лидерство решает ведущий по лоту за лотом.
  if (feed.final !== undefined) {
    return [
      finalFeedLine(feed.final.active, options),
      ...(mine.length === 0 ? [] : [mineLines(mine, options)]),
    ];
  }
  const happy = feed.lots.filter((item) => item.activeWindow !== undefined);
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

/**
 * Шапка ленты в живом финале (PER-639): лот на торгах с ценой и объявленной
 * ведущим суммой, а между лотами — что ведущий готовит следующий.
 */
export function finalFeedLine(
  active: FeedItem | undefined,
  options: Pick<MineOptions, "title">,
): string {
  if (active === undefined) {
    return "Идёт финал: ведущий готовит следующий лот.";
  }
  const { status } = active;
  const price =
    status.kind === "trading" || status.kind === "held"
      ? `, цена ${money(status.currentPrice)}`
      : "";
  const ask =
    status.kind === "trading" && status.ask !== undefined
      ? `, ведущий объявил ${money(status.ask)}`
      : "";
  return `Идёт финал: сейчас «${options.title(active)}»${price}${ask}.`;
}

/**
 * Подпись кнопки лота в ленте финала (PER-639): лот на торгах выделен, лоты
 * состава, которые ждут очереди, помечены — так они видны отдельно от
 * проданных. `null` — подпись обычная.
 */
export function finalFeedLabel(
  item: FeedItem,
  final: { active?: FeedItem },
  title: string,
): string | null {
  if (final.active?.lotId === item.lotId) return `▶ ${title} · на торгах`;
  if (item.status.kind === "held") {
    return `${title} · в составе · ${money(item.status.currentPrice)}`;
  }
  return null;
}

/** Сводка ленты, пока аукцион не открыл торги (PER-618). */
export const beforeTradingLine = "Торги ещё не начались. Лоты — кнопками ниже.";

/**
 * Абзацы сводки над «Избранным»: сколько лотов, затем свои — как у ленты.
 * У закончившегося аукциона лидировать уже не в чем: сводка говорит об итогах,
 * без «пока» (прогон 14.10, №106).
 */
export function favoritesSummary(
  total: number,
  mine: readonly FeedItem[],
  options: MineOptions & { ended?: boolean },
): string[] {
  const count = `Лотов в избранном: ${total}.`;
  if (options.ended === true) {
    return mine.length === 0
      ? [`${favoritesEndedLine} ${count} Итоги — кнопками ниже.`]
      : [
          `${favoritesEndedLine} ${count} Списком — что ты купил. Итоги всех — кнопками ниже.`,
          mineLines(mine, options),
        ];
  }
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

const favoritesEndedLine = "Аукцион закончен.";

/**
 * Пустое избранное: как его пополнить. У закончившегося аукциона пополнять
 * нечего — отметки уходят вместе с ним (ADR-063, дополнение 2026-10-12).
 */
export function favoritesEmptyText(ended?: boolean): string {
  return ended === true
    ? `${favoritesEndedLine} Избранное этого аукциона больше не хранится.`
    : favoritesEmpty;
}

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

/**
 * Строка хронологии ставок (PER-309), общая у двух оболочек: момент, имя,
 * сумма и способ ставки через «·». Снятие участника (ADR-072, PER-659) —
 * своя строка: цена, с которой лот пошёл дальше, и новый лидер. Имени нет —
 * Auction его не отдал, и строка остаётся без него: идентификатор человеку не
 * показывается. Момент форматирует оболочка, экранирование и зачёркивание
 * снятой ставки — тоже она: `struckHistoryLine`.
 */
export function historyLine(entry: HistoryItem, moment: string): string {
  switch (entry.kind) {
    case "bid":
      return [
        moment,
        ...(entry.participantName === undefined ? [] : [entry.participantName]),
        money(entry.amount),
        originLabel(entry.origin),
      ].join(" · ");
    case "removal":
      return [
        moment,
        "участник снят",
        `цена ${money(entry.price)}`,
        ...(entry.leaderName === undefined
          ? []
          : [`ведёт ${entry.leaderName}`]),
      ].join(" · ");
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/**
 * Ставку снятого участника хронология показывает зачёркнутой (PER-659):
 * спор читает её, но лот её уже не считает. `line` — строка, уже
 * экранированная для HTML.
 */
export function struckHistoryLine(entry: HistoryItem, line: string): string {
  return entry.kind === "bid" && entry.removed === true
    ? `<s>${line}</s>`
    : line;
}

function originLabel(origin: BidOriginView): string {
  switch (origin.kind) {
    case "proxy":
      return "авто";
    case "manual":
      return origin.source === "floor" ? "в зале" : "вручную";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

/**
 * Хвост подписи кнопки лота в ленте и избранном после названия (прогон 14.10,
 * №83): цена, а у лидера ещё «ты лидер» — словом, без знака (решение
 * владельца по прогону 14.10). Лидер видит себя и на кнопке, а не только в
 * сводке над ней; название оболочка обрезает под хвост, чтобы отметка не ушла
 * за предел подписи.
 */
export function lotButtonTail(item: FeedItem, price: string): string {
  return item.standing === "leader" ? ` · ${price} · ты лидер` : ` · ${price}`;
}

/**
 * Кнопка раздела ленты (PER-719) у обеих оболочек: название раздела в одну
 * строку и число его лотов, как «Материалы (N)» на карточке сходки.
 */
export function feedSectionLabel(section: {
  name: string;
  lotCount: number;
}): string {
  const tail = ` (${section.lotCount})`;
  const name = section.name.replace(/\s+/g, " ").trim();
  return `${truncate(name, 64 - tail.length)}${tail}`;
}

/** Заголовок экрана раздела: «Лоты · Книги». */
export function feedSectionTitle(name: string): string {
  return `Лоты · ${name.replace(/\s+/g, " ").trim()}`;
}
