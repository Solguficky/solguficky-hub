import type { Money as WireMoney } from "../../../gen/auction/v1/auction_pb.js";
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
  | { kind: "lot-reminder"; lotId: string };

const lotNoticeKinds: ReadonlySet<string> = new Set<LotNotice["kind"]>([
  "lot-outbid",
  "lot-proxy-raised",
  "lot-purchased",
  "lot-activity-digest",
  "lot-reminder",
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
      | "lotReminder";
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
function canonical(id: string): string | undefined {
  return CANONICAL_UUID.test(id) ? id : undefined;
}

// Сумма без кода валюты ISO 4217 или вне безопасного целого — нарушение
// контракта: цену в уведомлении нельзя показать приблизительно, а код не той
// формы уронил бы форматирование на каждой попытке.
const CURRENCY = /^[A-Z]{3}$/;

function toMoney(money: WireMoney | undefined): NoticeMoney | undefined {
  if (money === undefined || !CURRENCY.test(money.currency)) return undefined;
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return undefined;
  return { minorUnits, currency: money.currency };
}

// Чтения, которые нужны тексту. Название лота отдаёт Auction только зрителю с
// правом `place-bids`, а право получателя канал не придумывает — спрашивает у
// Identity (integration.md, `CheckAccessRight`).
export type LotNoticeReads = {
  // true — право есть, false — нет; недоступность Identity — исключение.
  holdsPlaceBids(identityId: string, requestId?: string): Promise<boolean>;
  // Название лота глазами получателя; любой отказ — исключение со своим кодом.
  lotTitle(
    identityId: string,
    lotId: string,
    requestId?: string,
  ): Promise<string>;
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
}: LotNoticeRenderOptions): (
  notice: LotNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
  return async (notice, context) => {
    const titles = new Map<string, string>();
    const refused = new Set<string>();
    if (reads === undefined) {
      return {
        kind: "ready",
        message: renderLotNotice(notice, { titles, refused, frequencyButton }),
      };
    }
    const { recipientId, requestId } = context;
    const stop = await checkPlaceBids(reads, context);
    if (stop !== undefined) return stop;
    if (notice.kind === "lot-activity-digest") {
      const lotIds = shownLots(notice.lines);
      const settled = await Promise.allSettled(
        lotIds.map((lotId) => reads.lotTitle(recipientId, lotId, requestId)),
      );
      settled.forEach((result, index) => {
        const lotId = lotIds[index];
        if (lotId === undefined) return;
        if (result.status === "fulfilled") {
          titles.set(lotId, result.value);
          return;
        }
        if (isPermanentFailure(result.reason)) refused.add(lotId);
        onTitleMissing(result.reason, requestId);
      });
    } else {
      try {
        titles.set(
          notice.lotId,
          await reads.lotTitle(recipientId, notice.lotId, requestId),
        );
      } catch (cause) {
        if (isPermanentFailure(cause)) return { kind: "rejected", cause };
        onTitleMissing(cause, requestId);
      }
    }
    return {
      kind: "ready",
      message: renderLotNotice(notice, { titles, refused, frequencyButton }),
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
  // Пустое название — у лота нет карточки: текст обходится без него.
  titles: ReadonlyMap<string, string>;
  // Лоты, которые Auction окончательно отказался отдать: кнопка к ним упёрлась
  // бы в тот же отказ.
  refused?: ReadonlySet<string>;
  frequencyButton: boolean;
};

export function renderLotNotice(
  notice: LotNotice,
  { titles, refused = new Set(), frequencyButton }: LotNoticeRenderInput,
): LotNoticeView {
  const frequency: LotNoticeButton = {
    kind: "frequency",
    text: frequencyLabel,
  };
  if (notice.kind === "lot-activity-digest") {
    const lots = shownLots(notice.lines);
    const shown = new Set(lots);
    const hidden = new Set(notice.lines.map((line) => line.lotId)).size;
    const text = [
      "Сводка по твоим ставкам:",
      "",
      ...notice.lines
        .filter((line) => shown.has(line.lotId))
        .map((line) => digestLine(line, titles.get(line.lotId))),
      ...(hidden > lots.length
        ? [`…и ещё лотов: ${hidden - lots.length}.`]
        : []),
    ].join("\n");
    const rows: LotNoticeButton[][] = lots
      .filter((lotId) => !refused.has(lotId))
      .map((lotId) => {
        const title = titles.get(lotId);
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
  const lot = quoted(titles.get(notice.lotId), TITLE_LIMIT);
  const lotButton: LotNoticeButton = {
    kind: "lot",
    lotId: notice.lotId,
    text: toLotLabel,
  };
  return {
    text: singleText(notice, lot),
    rows: [
      // Частота управляет перебитием, ответом автоставки и сводкой; покупки и
      // напоминания о дедлайне она не касается — напоминание выключается
      // снятием отметки (ADR-063, п.5).
      frequencyButton &&
      notice.kind !== "lot-purchased" &&
      notice.kind !== "lot-reminder"
        ? [lotButton, frequency]
        : [lotButton],
    ],
  };
}

function singleText(
  notice: Exclude<LotNotice, { kind: "lot-activity-digest" }>,
  lot: string | undefined,
): string {
  switch (notice.kind) {
    case "lot-outbid":
      return `Твою ставку на ${lot ?? "лот"} перебили. Текущая цена — ${money(notice.currentPrice)}.`;
    case "lot-proxy-raised":
      return `Твоя автоставка на ${lot ?? "лот"} подняла цену до ${money(notice.currentPrice)}: лидируешь ты.`;
    case "lot-purchased":
      // Оплаты и получения в продукте нет: их ведёт организатор аукциона, и
      // сообщение говорит только это (решение владельца 13 октября 2026 года).
      return `Лот ${lot === undefined ? "" : `${lot} `}твой за ${money(notice.price)}. Как оплатить и забрать — напишет организатор аукциона.`;
    case "lot-reminder":
      // Точного дедлайна в факте нет, а напоминание приходит не позже часа до
      // него — в том числе когда лот открыли с дедлайном ближе часа. Названный
      // «час» в этом случае был бы неправдой, поэтому текст говорит «скоро».
      return `Скоро дедлайн у избранного лота${lot === undefined ? "" : ` ${lot}`}. Успей сделать ставку.`;
    default: {
      const _exhaustive: never = notice;
      return _exhaustive;
    }
  }
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

function quoted(title: string | undefined, limit: number): string | undefined {
  return title === undefined || title === ""
    ? undefined
    : `«${truncate(title, limit)}»`;
}
