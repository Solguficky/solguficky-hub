import type { Money as WireMoney } from "../../../gen/auction/v1/auction_pb.js";
import type { LotSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import {
  LotActivityKind,
  type Notification,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  isPermanentFailure,
  type RenderContext,
  type RenderResult,
} from "../delivery/index.js";
import { type FormattedMoney, money, truncate } from "../format.js";
import type { Logger } from "../logging.js";

// Уведомления о лотах — перебитие, ответ автоставки, покупка, сводка за окно
// частоты (PER-596) и напоминание о дедлайне избранного лота (PER-496) — у двух
// ботов одни (PER-598): участнику их доставляет бот хаба, гостю — бот аукциона
// (ADR-064). Здесь разбор этих веток, чтения для названия лота, текст и ряды
// кнопок; данные кнопок каждая поверхность кодирует сама — у них разный
// префикс следа и разный путь к экрану частоты.

export type NoticeMoney = FormattedMoney;

export type LotActivityLine = {
  lotId: string;
  kind: "outbid" | "proxy-raised";
  // Цена и лидерство — на момент закрытия окна, а не события, которое строку
  // добавило: перебитие с `recipientLeads` значит, что лидерство вернулось.
  currentPrice: NoticeMoney;
  recipientLeads: boolean;
};

export type LotNotice =
  | { kind: "lot-outbid"; lotId: string; currentPrice: NoticeMoney }
  // Автоставка получателя ответила чужой команде и подняла цену; он лидер
  // (PER-473).
  | { kind: "lot-proxy-raised"; lotId: string; currentPrice: NoticeMoney }
  | { kind: "lot-purchased"; lotId: string; price: NoticeMoney }
  // Сводка окна частоты (PER-596): минимум одна строка, по строке на лот и вид.
  | { kind: "lot-activity-digest"; lines: readonly LotActivityLine[] }
  // Дедлайн избранного лота подходит (PER-496); данные — только идентификатор.
  | { kind: "lot-reminder"; lotId: string }
  // Второй момент того же напоминания: дедлайн уже близко (ADR-063,
  // дополнение 2026-10-20).
  | { kind: "lot-deadline-close"; lotId: string }
  // Следующий лот живого финала — тот, что человек вёл (ADR-063, дополнение
  // 2026-10-20).
  | { kind: "lot-final-next"; lotId: string; estimatedMinutes: number };

const lotNoticeKinds: ReadonlySet<string> = new Set<LotNotice["kind"]>([
  "lot-outbid",
  "lot-proxy-raised",
  "lot-purchased",
  "lot-activity-digest",
  "lot-reminder",
  "lot-deadline-close",
  "lot-final-next",
]);

/** Весть о лоте среди веток канала: её рисует общий рендер. */
export function isLotNotice<C extends { kind: string }>(
  content: C,
): content is Extract<C, LotNotice> {
  return lotNoticeKinds.has(content.kind);
}

type LotBranch = Extract<
  Notification["type"],
  {
    case:
      | "lotOutbid"
      | "lotProxyRaised"
      | "lotPurchased"
      | "lotActivityDigest"
      | "lotReminder"
      | "lotDeadlineClose"
      | "auctionFinalLotNext";
  }
>;

// Факт — ввод соседа: нарушение инвариантов ветки — дефект издателя, и разбор
// отвечает `undefined`, как у остальных веток.
export function lotNoticeOf(type: LotBranch): LotNotice | undefined {
  switch (type.case) {
    case "lotOutbid": {
      const lotId = canonical(type.value.lotId);
      const currentPrice = toMoney(type.value.currentPrice);
      return lotId === undefined || currentPrice === undefined
        ? undefined
        : { kind: "lot-outbid", lotId, currentPrice };
    }
    case "lotProxyRaised": {
      const lotId = canonical(type.value.lotId);
      const currentPrice = toMoney(type.value.currentPrice);
      return lotId === undefined || currentPrice === undefined
        ? undefined
        : { kind: "lot-proxy-raised", lotId, currentPrice };
    }
    case "lotPurchased": {
      const lotId = canonical(type.value.lotId);
      const price = toMoney(type.value.price);
      return lotId === undefined || price === undefined
        ? undefined
        : { kind: "lot-purchased", lotId, price };
    }
    case "lotActivityDigest": {
      // Сводка без строк контракт запрещает: окно без событий её не рождает.
      // Строка вида, которого эта сборка не знает, — из схемы новее: она
      // пропускается, а не роняет остальные; сводка без знакомых строк —
      // показать в ней нечего.
      const lines: LotActivityLine[] = [];
      for (const line of type.value.lines) {
        const kind = activityKind(line.kind);
        if (kind === undefined) continue;
        const lotId = canonical(line.lotId);
        const currentPrice = toMoney(line.currentPrice);
        if (lotId === undefined || currentPrice === undefined) {
          return undefined;
        }
        lines.push({
          lotId,
          kind,
          currentPrice,
          recipientLeads: line.recipientLeads,
        });
      }
      return lines.length === 0
        ? undefined
        : { kind: "lot-activity-digest", lines };
    }
    case "lotReminder": {
      // Напоминание несёт только лот: названия, цены и дедлайна у продюсера
      // нет, канал читает их у Auction по идентификатору.
      const lotId = canonical(type.value.lotId);
      return lotId === undefined ? undefined : { kind: "lot-reminder", lotId };
    }
    case "lotDeadlineClose": {
      const lotId = canonical(type.value.lotId);
      return lotId === undefined
        ? undefined
        : { kind: "lot-deadline-close", lotId };
    }
    case "auctionFinalLotNext": {
      const lotId = canonical(type.value.lotId);
      // Оценка длительности лота: число минут, сколько он примерно протянет.
      const estimatedMinutes = type.value.estimatedMinutes;
      if (lotId === undefined || estimatedMinutes < 0) return undefined;
      return { kind: "lot-final-next", lotId, estimatedMinutes };
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function activityKind(
  kind: LotActivityKind,
): LotActivityLine["kind"] | undefined {
  if (kind === LotActivityKind.OUTBID) return "outbid";
  if (kind === LotActivityKind.PROXY_RAISED) return "proxy-raised";
  return undefined;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Из идентификатора лота собирается кнопка: не каноническая форма уронила бы
// кодировщик на отправке, а не на разборе.
export function canonical(id: string): string | undefined {
  return CANONICAL_UUID.test(id) ? id : undefined;
}

// Сумма без кода валюты ISO 4217 или вне безопасного целого — нарушение
// контракта: цену в уведомлении нельзя показать приблизительно, а код не той
// формы уронил бы форматирование на каждой попытке.
const CURRENCY = /^[A-Z]{3}$/;

export function toMoney(money: WireMoney | undefined): NoticeMoney | undefined {
  if (money === undefined || !CURRENCY.test(money.currency)) return undefined;
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return undefined;
  return { minorUnits, currency: money.currency };
}

// Что канал узнаёт о лоте у Auction: название — для текста, дедлайн и число
// использованных продлений анти-снайпом — чтобы сказать, до какого времени
// идёт торг и продлевал ли дедлайн.
export type LotInfo = {
  // Карточки у лота может не быть: тогда текст обходится без названия.
  title: string;
  // Момент закрытия торгов по времени сервера; у лота без торгов его нет.
  deadline?: string;
  // Сколько раз анти-снайп продлил дедлайн. Ноль — реальное значение.
  extensionsUsed?: number;
};

// Перевод снимка Auction в то, о чём читает текст. Правило одно у двух
// ботов, и копия разошлась бы по поверхностям.
export function lotInfoOf(snapshot: LotSnapshot): LotInfo {
  // Карточки у лота может не быть: тогда текст обходится без названия.
  const title = snapshot.card?.title ?? "";
  // Дедлайн и число продлений есть только у лота в торгах: у лота без торгов
  // и у лота, который ведёт человек, их нет.
  const trading =
    snapshot.status?.case === "trading" ? snapshot.status.value : undefined;
  return {
    title,
    ...(trading?.deadline === undefined ? {} : { deadline: trading.deadline }),
    ...(trading === undefined
      ? {}
      : { extensionsUsed: trading.extensionsUsed }),
  };
}

// Чтения, которые нужны тексту. Название лота отдаёт Auction только зрителю с
// правом `place-bids`, а право получателя канал не придумывает — спрашивает у
// Identity (integration.md, `CheckAccessRight`).
export type LotNoticeReads = {
  // true — право есть, false — нет; недоступность Identity — исключение.
  holdsPlaceBids(identityId: string, requestId?: string): Promise<boolean>;
  // Лот глазами получателя; любой отказ — исключение со своим кодом.
  lotInfo(
    identityId: string,
    lotId: string,
    requestId?: string,
  ): Promise<LotInfo>;
};

// Кнопка уведомления: лот открывает карточку, частота — экран частоты; оба
// новым сообщением, уведомление остаётся в истории.
export type LotNoticeButton =
  | { kind: "lot"; lotId: string; text: string }
  | { kind: "frequency"; text: string };

export type LotNoticeView = {
  text: string;
  rows: readonly (readonly LotNoticeButton[])[];
};

const toLotLabel = "К лоту";
// Вход в частоту под тем, чем она управляет: перебитием, ответом автоставки и
// сводкой; покупку она не трогает (PER-596), и под покупкой кнопки нет.
const frequencyLabel = "Частота уведомлений";

// Название лота у Auction ничем не ограничено, а сообщение длиннее предела
// Telegram отвергается окончательно: уведомление потерялось бы целиком.
const TITLE_LIMIT = 200;
// Строка сводки и подпись кнопки короче: сводка несёт до десяти лотов.
const LINE_TITLE_LIMIT = 60;
const BUTTON_TITLE_LIMIT = 32;
// Сводка за час может набрать много лотов: текст ограничен 4096 символами,
// клавиатура — сотней кнопок. Лоты сверх предела называются числом.
export const DIGEST_LOT_LIMIT = 10;

export type LotNoticeRenderOptions = {
  // Нет — бот без Auction: текст без названий и без проверки права, которое
  // некому подтвердить.
  reads: LotNoticeReads | undefined;
  onTitleMissing: (cause: unknown, requestId?: string) => void;
  // У бота есть Notifications: кнопка частоты стоит под тем, чем она управляет.
  frequencyButton: boolean;
  // Пояс сообщества: время дедлайна человек читает по своему часовому поясу.
  timeZone: string;
};

// Право `place-bids` получателя перед вестью о торгах: без него кнопка упёрлась
// бы в тот же отказ, а человек, у которого право сняли, о торгах больше не
// слышит. `undefined` — право есть; иначе — исход, которым весть кончается.
export async function checkPlaceBids(
  reads: LotNoticeReads,
  { recipientId, requestId }: RenderContext,
): Promise<Exclude<RenderResult<never>, { kind: "ready" }> | undefined> {
  let eligible: boolean;
  try {
    eligible = await reads.holdsPlaceBids(recipientId, requestId);
  } catch (cause) {
    return isPermanentFailure(cause)
      ? { kind: "rejected", cause }
      : { kind: "unavailable", cause };
  }
  return eligible ? undefined : { kind: "ineligible" };
}

// Сборка уведомления о лоте. Недоступный Auction названия не роняет: весть
// ценна вовремя, а название видно в карточке по кнопке. У одиночного
// уведомления отказ, который повтор не изменит, — дефект: оно снимается, а не
// уходит с кнопкой в тот же отказ. У сводки такой отказ по одному лоту
// остальные строки не роняет: его строка уходит без названия и без кнопки, а
// отказ пишется в лог.
export function createLotNoticeRender({
  reads,
  onTitleMissing,
  frequencyButton,
  timeZone,
}: LotNoticeRenderOptions): (
  notice: LotNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
  return async (notice, context) => {
    const lots = new Map<string, LotInfo>();
    const refused = new Set<string>();
    if (reads === undefined) {
      return {
        kind: "ready",
        message: renderLotNotice(notice, {
          lots,
          refused,
          frequencyButton,
          timeZone,
        }),
      };
    }
    const { recipientId, requestId } = context;
    const stop = await checkPlaceBids(reads, context);
    if (stop !== undefined) return stop;
    if (notice.kind === "lot-activity-digest") {
      const lotIds = shownLots(notice.lines);
      const settled = await Promise.allSettled(
        lotIds.map((lotId) => reads.lotInfo(recipientId, lotId, requestId)),
      );
      settled.forEach((result, index) => {
        const lotId = lotIds[index];
        if (lotId === undefined) return;
        if (result.status === "fulfilled") {
          lots.set(lotId, result.value);
          return;
        }
        if (isPermanentFailure(result.reason)) refused.add(lotId);
        onTitleMissing(result.reason, requestId);
      });
    } else {
      try {
        lots.set(
          notice.lotId,
          await reads.lotInfo(recipientId, notice.lotId, requestId),
        );
      } catch (cause) {
        if (isPermanentFailure(cause)) return { kind: "rejected", cause };
        onTitleMissing(cause, requestId);
      }
    }
    return {
      kind: "ready",
      message: renderLotNotice(notice, {
        lots,
        refused,
        frequencyButton,
        timeZone,
      }),
    };
  };
}

// Запись о названии, которого текст не получил. Окончательный отказ по лоту —
// нарушение инварианта у соседа, а не его недоступность, и в логе они
// различимы.
export function logMissingTitle(
  logger: Pick<Logger, "warn">,
): (cause: unknown, requestId?: string) => void {
  return (cause, requestId) =>
    logger.warn("lot title unavailable", {
      ...(requestId === undefined ? {} : { request_id: requestId }),
      error_category: isPermanentFailure(cause)
        ? "invariant"
        : "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
}

// Лоты сводки в порядке первого появления, без повторов — у лота могут быть две
// строки, перебитие и ответ автоставки, — и не больше предела.
function shownLots(lines: readonly LotActivityLine[]): string[] {
  return [...new Set(lines.map((line) => line.lotId))].slice(
    0,
    DIGEST_LOT_LIMIT,
  );
}

export type LotNoticeRenderInput = {
  // Лоты, о которых канал знает: название и, у лота в торгах, дедлайн.
  lots: ReadonlyMap<string, LotInfo>;
  // Лоты, которые Auction окончательно отказался отдать: кнопка к ним упёрлась
  // бы в тот же отказ.
  refused?: ReadonlySet<string>;
  frequencyButton: boolean;
  timeZone: string;
};

export function renderLotNotice(
  notice: LotNotice,
  {
    lots,
    refused = new Set(),
    frequencyButton,
    timeZone,
  }: LotNoticeRenderInput,
): LotNoticeView {
  const frequency: LotNoticeButton = {
    kind: "frequency",
    text: frequencyLabel,
  };
  if (notice.kind === "lot-activity-digest") {
    const shown = shownLots(notice.lines);
    const shownSet = new Set(shown);
    const hidden = new Set(notice.lines.map((line) => line.lotId)).size;
    const text = [
      "Сводка по твоим ставкам:",
      "",
      ...notice.lines
        .filter((line) => shownSet.has(line.lotId))
        .map((line) => digestLine(line, lots.get(line.lotId)?.title)),
      ...(hidden > shown.length
        ? [`…и ещё лотов: ${hidden - shown.length}.`]
        : []),
    ].join("\n");
    const rows: LotNoticeButton[][] = shown
      .filter((lotId) => !refused.has(lotId))
      .map((lotId) => {
        const title = lots.get(lotId)?.title;
        return [
          {
            kind: "lot",
            lotId,
            text:
              title === undefined || title === ""
                ? toLotLabel
                : truncate(title, BUTTON_TITLE_LIMIT),
          },
        ];
      });
    if (frequencyButton) rows.push([frequency]);
    return { text, rows };
  }
  const info = lots.get(notice.lotId);
  const lot = quoted(info?.title, TITLE_LIMIT);
  const lotButton: LotNoticeButton = {
    kind: "lot",
    lotId: notice.lotId,
    text: toLotLabel,
  };
  return {
    text: singleText(notice, lot, info, timeZone),
    rows: [
      // Частота управляет перебитием, ответом автоставки и сводкой; покупки и
      // напоминания о дедлайне она не касается — напоминание выключается
      // снятием отметки (ADR-063, п.5).
      frequencyButton &&
      notice.kind !== "lot-purchased" &&
      notice.kind !== "lot-reminder" &&
      notice.kind !== "lot-deadline-close" &&
      notice.kind !== "lot-final-next"
        ? [lotButton, frequency]
        : [lotButton],
    ],
  };
}

function singleText(
  notice: Exclude<LotNotice, { kind: "lot-activity-digest" }>,
  lot: string | undefined,
  info: LotInfo | undefined,
  timeZone: string,
): string {
  switch (notice.kind) {
    case "lot-outbid":
      return `Твою ставку на ${lot ?? "лот"} перебили. Текущая цена — ${money(notice.currentPrice)}.${deadlineText(info, timeZone)}`;
    case "lot-proxy-raised":
      return `Твоя автоставка на ${lot ?? "лот"} подняла цену до ${money(notice.currentPrice)}: лидируешь ты.${deadlineText(info, timeZone)}`;
    case "lot-purchased":
      // Оплаты и получения в продукте нет: их ведёт организатор аукциона, и
      // сообщение говорит только это (решение владельца 13 октября 2026 года).
      return `Лот ${lot === undefined ? "" : `${lot} `}твой за ${money(notice.price)}. Как оплатить и забрать — напишет организатор аукциона.`;
    case "lot-reminder":
      // Напоминание приходит не позже часа до дедлайна — в том числе когда лот
      // открыли с дедлайном ближе часа, — поэтому «час» в тексте был бы
      // неправдой. Время дедлайна канал читает у Auction: после продления
      // анти-снайпом названо то, до которого торг идёт сейчас.
      return `Скоро дедлайн у избранного лота${lot === undefined ? "" : ` ${lot}`}${deadlineTime(info, timeZone)}. Успей сделать ставку.`;
    case "lot-deadline-close":
      // Второй момент того же напоминания: дедлайн уже близко, и время названо
      // прямо — «скоро» здесь было бы пустым словом.
      return `Дедлайн избранного лота${lot === undefined ? "" : ` ${lot}`}${deadlineTime(info, timeZone)}. Успей сделать ставку.`;
    case "lot-final-next":
      return `Твой лот следующий: ${lot ?? "лот"}.${minutesText(notice.estimatedMinutes)}`;
    default: {
      const _exhaustive: never = notice;
      return _exhaustive;
    }
  }
}

// Дедлайн лота в тексте: время по часам сообщества и, когда Auction сообщил о
// продлении анти-снайпом, слово о нём. Продление двигает дедлайн, поэтому
// время, названное без слова «продлён», осталось бы верным.
function deadlineText(info: LotInfo | undefined, timeZone: string): string {
  const when = deadlineMoment(info, timeZone);
  if (when === undefined) return "";
  return (info?.extensionsUsed ?? 0) > 0
    ? ` Дедлайн продлён до ${when}.`
    : ` Торг до ${when}.`;
}

// Время дедлайна по часам сообщества: « — до 22:45». Лот без торгов и лот,
// которого ведёт человек, дедлайна не имеют — тогда времени нет.
function deadlineTime(info: LotInfo | undefined, timeZone: string): string {
  const when = deadlineMoment(info, timeZone);
  return when === undefined ? "" : ` — до ${when}`;
}

// Время дедлайна по часам сообщества: «22:45».
function deadlineMoment(
  info: LotInfo | undefined,
  timeZone: string,
): string | undefined {
  if (info?.deadline === undefined) return undefined;
  return localTime(info.deadline, timeZone);
}

// Оценка длительности лота финала: «Примерно через 7 минут.» Число округлено
// в сервисе, а здесь оно только читается.
function minutesText(estimatedMinutes: number): string {
  return estimatedMinutes <= 0
    ? ""
    : ` Примерно через ${estimatedMinutes} ${plural(estimatedMinutes, "минуту", "минуты", "минут")}.`;
}

// Момент RFC 3339 в местное время пояса: «22:45». Непонятный момент —
// отсутствие времени, а не «00:00».
export function localTime(
  instant: string,
  timeZone: string,
): string | undefined {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (hour === undefined || minute === undefined) return undefined;
  return `${hour}:${minute}`;
}

// Число со словом: «1 минуту», «7 минут».
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// «Лот за тобой» верно и для лидера торгов, и для купившего: лот, проданный в
// окне, приходит в сводку с ценой продажи, а факт не говорит, продан ли он.
function digestLine(line: LotActivityLine, title: string | undefined): string {
  const lot = quoted(title, LINE_TITLE_LIMIT) ?? "Лот";
  const price = money(line.currentPrice);
  if (line.kind === "outbid") {
    return line.recipientLeads
      ? `• ${lot} — перебивали, но лот за тобой: ${price}`
      : `• ${lot} — перебили, цена ${price}`;
  }
  return line.recipientLeads
    ? `• ${lot} — автоставка подняла цену до ${price}, лот за тобой`
    : `• ${lot} — автоставка отвечала, но тебя перебили: ${price}`;
}

export function quoted(
  title: string | undefined,
  limit: number,
): string | undefined {
  return title === undefined || title === ""
    ? undefined
    : `«${truncate(title, limit)}»`;
}
