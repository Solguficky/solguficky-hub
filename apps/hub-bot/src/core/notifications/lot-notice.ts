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

// Уведомления о лотах — перебитие, ответ автоставки, покупка и сводка за окно
// частоты (PER-596) — у двух ботов одни (PER-598): участнику их доставляет бот
// хаба, гостю — бот аукциона (ADR-064). Здесь разбор этих веток, чтения для
// названия лота, текст и ряды кнопок; данные кнопок каждая поверхность кодирует
// сама — у них разный префикс следа и разный путь к экрану частоты.

export type NoticeMoney = { minorUnits: number; currency: string };

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
  | { kind: "lot-activity-digest"; lines: readonly LotActivityLine[] };

const lotNoticeKinds: ReadonlySet<string> = new Set<LotNotice["kind"]>([
  "lot-outbid",
  "lot-proxy-raised",
  "lot-purchased",
  "lot-activity-digest",
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
    case: "lotOutbid" | "lotProxyRaised" | "lotPurchased" | "lotActivityDigest";
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
      if (type.value.lines.length === 0) return undefined;
      const lines: LotActivityLine[] = [];
      for (const line of type.value.lines) {
        const lotId = canonical(line.lotId);
        const currentPrice = toMoney(line.currentPrice);
        const kind = activityKind(line.kind);
        if (
          lotId === undefined ||
          currentPrice === undefined ||
          kind === undefined
        ) {
          return undefined;
        }
        lines.push({
          lotId,
          kind,
          currentPrice,
          recipientLeads: line.recipientLeads,
        });
      }
      return { kind: "lot-activity-digest", lines };
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

export const toLotLabel = "К лоту";
// Вход в частоту под тем, чем она управляет: перебитием, ответом автоставки и
// сводкой; покупку она не трогает (PER-596), и под покупкой кнопки нет.
export const frequencyLabel = "Частота уведомлений";

// Название лота у Auction ничем не ограничено, а сообщение длиннее предела
// Telegram отвергается окончательно: уведомление потерялось бы целиком.
const TITLE_LIMIT = 200;
// Строка сводки и подпись кнопки короче: сводка несёт до десяти лотов.
const LINE_TITLE_LIMIT = 60;
const BUTTON_TITLE_LIMIT = 32;
// Сводка за час может набрать много лотов: текст ограничен 4096 символами,
// клавиатура — сотней кнопок. Остальное называется числом.
export const DIGEST_LINE_LIMIT = 10;

// Сборка уведомления о лоте. Без права `place-bids` уведомление не уходит: кнопка
// упёрлась бы в тот же отказ, а человек, у которого право сняли, о торгах больше
// не слышит. Недоступный Auction названия не роняет: весть ценна вовремя, а
// название видно в карточке по кнопке. У одиночного уведомления отказ, который
// повтор не изменит, — дефект: оно снимается, а не уходит с кнопкой в тот же
// отказ. У сводки такой отказ по одному лоту остальные строки не роняет: строка
// уходит без названия, а отказ пишется в лог.
//
// `reads` нет — бот без Auction: текст без названий. `frequency` — у бота есть
// Notifications, и кнопка частоты стоит под тем, чем она управляет.
export function createLotNoticeRender(
  reads: LotNoticeReads | undefined,
  onTitleMissing: (cause: unknown, requestId?: string) => void,
  frequency: boolean,
): (
  notice: LotNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
  return async (notice, { recipientId, requestId }) => {
    if (reads === undefined) {
      return {
        kind: "ready",
        message: renderLotNotice(notice, new Map(), frequency),
      };
    }
    let eligible: boolean;
    try {
      eligible = await reads.holdsPlaceBids(recipientId, requestId);
    } catch (cause) {
      return isPermanentFailure(cause)
        ? { kind: "rejected", cause }
        : { kind: "unavailable", cause };
    }
    if (!eligible) return { kind: "ineligible" };
    const titles = new Map<string, string>();
    if (notice.kind === "lot-activity-digest") {
      const lotIds = shownLotIds(notice.lines);
      const settled = await Promise.allSettled(
        lotIds.map((lotId) => reads.lotTitle(recipientId, lotId, requestId)),
      );
      settled.forEach((result, index) => {
        const lotId = lotIds[index];
        if (lotId === undefined) return;
        if (result.status === "fulfilled") titles.set(lotId, result.value);
        else onTitleMissing(result.reason, requestId);
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
      message: renderLotNotice(notice, titles, frequency),
    };
  };
}

// Лоты показанных строк сводки — в порядке первого появления, без повторов:
// у лота могут быть две строки, перебитие и ответ автоставки.
function shownLotIds(lines: readonly LotActivityLine[]): string[] {
  return [
    ...new Set(lines.slice(0, DIGEST_LINE_LIMIT).map((line) => line.lotId)),
  ];
}

// Пустое название — у лота нет карточки: текст обходится без него.
export function renderLotNotice(
  notice: LotNotice,
  titles: ReadonlyMap<string, string>,
  frequency: boolean,
): LotNoticeView {
  const frequencyButton: LotNoticeButton = {
    kind: "frequency",
    text: frequencyLabel,
  };
  if (notice.kind === "lot-activity-digest") {
    const shown = notice.lines.slice(0, DIGEST_LINE_LIMIT);
    const hidden = notice.lines.length - shown.length;
    const text = [
      "Сводка по твоим ставкам:",
      "",
      ...shown.map((line) => digestLine(line, titles.get(line.lotId))),
      ...(hidden > 0 ? [`…и ещё ${hidden}.`] : []),
    ].join("\n");
    const rows: LotNoticeButton[][] = shownLotIds(notice.lines).map((lotId) => {
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
    if (frequency) rows.push([frequencyButton]);
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
      frequency && notice.kind !== "lot-purchased"
        ? [lotButton, frequencyButton]
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
      return `Твою ставку на ${lot ?? "лот"} перебили. Текущая цена — ${noticeMoney(notice.currentPrice)}.`;
    case "lot-proxy-raised":
      return `Твоя автоставка на ${lot ?? "лот"} подняла цену до ${noticeMoney(notice.currentPrice)}: лидируешь ты.`;
    case "lot-purchased":
      // Оплаты и получения в продукте нет: их ведёт организатор аукциона, и
      // сообщение говорит только это (решение владельца 13 октября 2026 года).
      return `Лот ${lot === undefined ? "" : `${lot} `}твой за ${noticeMoney(notice.price)}. Как оплатить и забрать — напишет организатор аукциона.`;
    default: {
      const _exhaustive: never = notice;
      return _exhaustive;
    }
  }
}

function digestLine(line: LotActivityLine, title: string | undefined): string {
  const lot = quoted(title, LINE_TITLE_LIMIT) ?? "Лот";
  const price = noticeMoney(line.currentPrice);
  if (line.kind === "outbid") {
    return line.recipientLeads
      ? `• ${lot} — перебивали, но лидируешь ты: ${price}`
      : `• ${lot} — перебили, цена ${price}`;
  }
  return line.recipientLeads
    ? `• ${lot} — автоставка подняла цену до ${price}, лидируешь ты`
    : `• ${lot} — автоставка отвечала, но тебя перебили: ${price}`;
}

function quoted(title: string | undefined, limit: number): string | undefined {
  return title === undefined || title === ""
    ? undefined
    : `«${truncate(title, limit)}»`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > limit - 1) break;
    kept += point;
  }
  return `${kept}…`;
}

export function noticeMoney(amount: NoticeMoney): string {
  const whole = amount.minorUnits % 100 === 0;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount.minorUnits / 100);
}
