import type { Notification } from "../../../gen/notifications/v1/notifications_pb.js";
import {
  isPermanentFailure,
  type RenderContext,
  type RenderResult,
} from "../delivery/index.js";
import { money, truncate } from "../format.js";
import {
  canonical,
  checkPlaceBids,
  DIGEST_LOT_LIMIT,
  type LotInfo,
  type LotNoticeButton,
  type LotNoticeRenderOptions,
  type LotNoticeView,
  type NoticeMoney,
  quoted,
  toMoney,
} from "./lot-notice.js";

// Вести конца онлайн-торгов и финала (PER-477, PER-478, PER-812) — конец
// онлайн-торгов, состав и старт живого финала всем держателям права ставок,
// а не только ведшим лот, и продажа лота финала тем, кто на него ставил. У двух ботов он один, по кругу получателя, как вести о
// лотах (ADR-064, п. 16): участнику его доставляет бот хаба, гостю — бот
// аукциона. «Твой лот в финале» — не своя ветка, а тот же состав с непустым
// `your_lot_ids`: факт на человека один. Вид — ряды кнопок вести о лоте, и
// данные кнопок каждая поверхность кодирует своим следом лота.

export type FinalLineupLot = { lotId: string; price: NoticeMoney };

export type FinalNotice =
  | {
      kind: "final-lineup";
      auctionId: string;
      // Не меньше одного лота, в порядке финала; цена — на момент удержания.
      lineup: readonly FinalLineupLot[];
      // Лоты состава, которые получатель вёл, в порядке состава; пусто —
      // простой анонс.
      yourLotIds: readonly string[];
    }
  | { kind: "final-started"; auctionId: string }
  // Конец онлайн-торгов: сколько лотов продано и сколько ждёт финала; ноль
  // удержанных — финала не будет.
  | {
      kind: "prebidding-ended";
      auctionId: string;
      soldCount: number;
      heldCount: number;
    }
  // Лот финала продан не тебе, а ты на него ставил.
  | { kind: "lot-sold-in-final"; lotId: string; price: NoticeMoney };

const finalNoticeKinds: ReadonlySet<string> = new Set<FinalNotice["kind"]>([
  "final-lineup",
  "final-started",
  "prebidding-ended",
  "lot-sold-in-final",
]);

/** Анонс финала среди веток канала: его рисует общий рендер. */
export function isFinalNotice<C extends { kind: string }>(
  content: C,
): content is Extract<C, FinalNotice> {
  return finalNoticeKinds.has(content.kind);
}

type FinalBranch = Extract<
  Notification["type"],
  {
    case:
      | "auctionFinalLineup"
      | "auctionFinalStarted"
      | "auctionPrebiddingEnded"
      | "auctionLotSoldInFinal";
  }
>;

// Факт — ввод соседа: пустой состав, лот или аукцион не в канонической форме,
// повтор лота в составе, цена без валюты и «свой» лот вне состава — дефект
// издателя, и разбор отвечает `undefined`, как у остальных веток. Свои лоты
// разбор ставит в порядок состава сам: кнопки идут в порядке финала, а не
// провода.
export function finalNoticeOf(type: FinalBranch): FinalNotice | undefined {
  if (type.case === "auctionLotSoldInFinal") {
    const lotId = canonical(type.value.lotId);
    const price = toMoney(type.value.price);
    return lotId === undefined || price === undefined
      ? undefined
      : { kind: "lot-sold-in-final", lotId, price };
  }
  const auctionId = canonical(type.value.auctionId);
  if (auctionId === undefined) return undefined;
  if (type.case === "auctionFinalStarted") {
    return { kind: "final-started", auctionId };
  }
  if (type.case === "auctionPrebiddingEnded") {
    return {
      kind: "prebidding-ended",
      auctionId,
      soldCount: type.value.soldCount,
      heldCount: type.value.heldCount,
    };
  }
  const lineup: FinalLineupLot[] = [];
  for (const lot of type.value.lineup) {
    const lotId = canonical(lot.lotId);
    const price = toMoney(lot.price);
    if (lotId === undefined || price === undefined) return undefined;
    lineup.push({ lotId, price });
  }
  if (lineup.length === 0) return undefined;
  const inLineup = new Set(lineup.map((lot) => lot.lotId));
  if (inLineup.size !== lineup.length) return undefined;
  const own = new Set(type.value.yourLotIds);
  if (![...own].every((lotId) => inLineup.has(lotId))) return undefined;
  const yourLotIds = lineup
    .map((lot) => lot.lotId)
    .filter((lotId) => own.has(lotId));
  return { kind: "final-lineup", auctionId, lineup, yourLotIds };
}

// Состав финала невелик, но предела в контракте нет, а текст ограничен 4096
// символами: чужие лоты сверх предела называются числом, а свои стоят строкой
// всегда — первая строка их обещает. Кнопки — только свои лоты, не больше, чем
// у сводки.
export const LINEUP_LOT_LIMIT = 20;
const OWN_LOT_BUTTON_LIMIT = DIGEST_LOT_LIMIT;
const LINE_TITLE_LIMIT = 60;
const BUTTON_TITLE_LIMIT = 32;
const toLotLabel = "К лоту";

// Строки состава в тексте: первые по пределу и все свои, в порядке финала.
// Им же нужны названия — свои лоты под кнопками среди них.
function shownLineup(
  notice: Extract<FinalNotice, { kind: "final-lineup" }>,
): FinalLineupLot[] {
  const own = new Set(notice.yourLotIds);
  return notice.lineup.filter(
    (lot, index) => index < LINEUP_LOT_LIMIT || own.has(lot.lotId),
  );
}

/**
 * Сколько процесс помнит прочитанный лот состава (PER-704). Анонс уходит
 * каждому, кто вёл лот аукциона, — сотне человек за раз при старте финала, —
 * и без памяти каждый получатель читал бы те же лоты заново. Рассылка одного
 * факта укладывается в эти секунды, а название, изменённое после неё,
 * следующий анонс прочитает заново.
 */
export const LINEUP_LOT_TTL_MS = 60_000;

type RememberedLot = { readAt: number; info: LotInfo };

// Сборка анонса. Весть о торгах: без права `place-bids` она не уходит, как
// вести о лотах, и право спрашивается у каждого получателя. Недоступный
// Auction роняет только названия — строка состава остаётся с ценой; лот,
// который Auction окончательно не отдал, остаётся строкой без названия и без
// кнопки, а отказ пишется в лог.
//
// Лоты состава одни на всех получателей, поэтому рендер читает каждый лот
// один раз на рассылку: прочитанный лот живёт в памяти `LINEUP_LOT_TTL_MS`.
// Доставка идёт по одному факту, поэтому помнится только прочитанное, а не
// само чтение: отказ и лот без названия — карточка ещё не в read model — не
// запоминаются, и следующий получатель читает лот сам, своим `request_id`.
// Название одно у всех, кто видит лот, а видят лот финала все, кому весть и
// адресована.
export function createFinalNoticeRender({
  reads,
  onTitleMissing,
  now = Date.now,
  timeZone = "UTC",
}: Omit<LotNoticeRenderOptions, "frequencyButton" | "timeZone"> & {
  // Часы памяти о лотах; подменяет тест.
  now?: () => number;
  // Пояс сообщества: время финала человек читает по нему.
  timeZone?: string;
}): (
  notice: FinalNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
  const lotsById = new Map<string, RememberedLot>();
  // Часы, ушедшие назад, тоже считаются истечением: иначе запись прожила бы
  // дольше своего срока.
  const fresh = (lot: RememberedLot, at: number) => {
    const age = at - lot.readAt;
    return age >= 0 && age < LINEUP_LOT_TTL_MS;
  };
  return async (notice, context) => {
    const lots = new Map<string, LotInfo>();
    const refused = new Set<string>();
    if (reads === undefined) {
      return {
        kind: "ready",
        message: renderFinalNotice(notice, { lots, refused }),
      };
    }
    const stop = await checkPlaceBids(reads, context);
    if (stop !== undefined) return stop;
    if (notice.kind === "prebidding-ended") {
      // Время финала — необязательная строка: не выставлено или не
      // прочиталось — весть уходит без неё.
      let finalAt: string | undefined;
      if (notice.heldCount > 0 && reads.auctionFinalAt !== undefined) {
        try {
          finalAt = await reads.auctionFinalAt(
            context.recipientId,
            notice.auctionId,
            context.requestId,
          );
        } catch (cause) {
          onTitleMissing(cause, context.requestId);
        }
      }
      return {
        kind: "ready",
        message: renderFinalNotice(notice, {
          lots,
          refused,
          timeZone,
          ...(finalAt === undefined ? {} : { finalAt }),
        }),
      };
    }
    if (notice.kind === "lot-sold-in-final") {
      try {
        lots.set(
          notice.lotId,
          await reads.lotInfo(
            context.recipientId,
            notice.lotId,
            context.requestId,
          ),
        );
      } catch (cause) {
        if (isPermanentFailure(cause)) refused.add(notice.lotId);
        onTitleMissing(cause, context.requestId);
      }
    }
    if (notice.kind === "final-lineup") {
      const { recipientId, requestId } = context;
      const at = now();
      for (const [lotId, lot] of lotsById) {
        if (!fresh(lot, at)) lotsById.delete(lotId);
      }
      const lotIds = shownLineup(notice).map((lot) => lot.lotId);
      const toRead = lotIds.filter((lotId) => {
        const known = lotsById.get(lotId);
        if (known === undefined) return true;
        lots.set(lotId, known.info);
        return false;
      });
      const settled = await Promise.allSettled(
        toRead.map((lotId) => reads.lotInfo(recipientId, lotId, requestId)),
      );
      settled.forEach((result, index) => {
        const lotId = toRead[index];
        if (lotId === undefined) return;
        if (result.status === "fulfilled") {
          lots.set(lotId, result.value);
          if (result.value.title !== "") {
            lotsById.set(lotId, { readAt: at, info: result.value });
          }
          return;
        }
        if (isPermanentFailure(result.reason)) refused.add(lotId);
        onTitleMissing(result.reason, requestId);
      });
    }
    return {
      kind: "ready",
      message: renderFinalNotice(notice, { lots, refused }),
    };
  };
}

export type FinalNoticeRenderInput = {
  lots: ReadonlyMap<string, LotInfo>;
  refused?: ReadonlySet<string>;
  // Для вести о конце торгов: пояс и ориентировочное время финала.
  timeZone?: string;
  finalAt?: string;
};

// Момент по часам сообщества: «30.10 в 20:00». Непонятный момент — отсутствие
// строки, а не «00.00».
function localMoment(instant: string, timeZone: string): string | undefined {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const [day, month, hour, minute] = [
    part("day"),
    part("month"),
    part("hour"),
    part("minute"),
  ];
  return day === undefined ||
    month === undefined ||
    hour === undefined ||
    minute === undefined
    ? undefined
    : `${day}.${month} в ${hour}:${minute}`;
}

// Строка «Объявлен состав финала» или «Твой лот в финале», пустая строка и
// строки состава «• «Лот» — цена» в порядке финала; свой лот — с «лот за
// тобой», как в сводке. Под составом — ряд на каждый свой лот с его названием:
// карточка приходит новым сообщением. У простого анонса и старта финала кнопок
// нет (решение владельца 19 октября 2026 года, PER-478).
export function renderFinalNotice(
  notice: FinalNotice,
  {
    lots,
    refused = new Set(),
    timeZone = "UTC",
    finalAt,
  }: FinalNoticeRenderInput,
): LotNoticeView {
  if (notice.kind === "final-started") {
    return { text: "Начался финал аукциона.", rows: [] };
  }
  if (notice.kind === "prebidding-ended") {
    if (notice.heldCount === 0) {
      return {
        text: [
          `Онлайн-торги закончились. Продано лотов: ${notice.soldCount}.`,
          "",
          "Финала не будет: итоги аукциона смотри в боте.",
        ].join("\n"),
        rows: [],
      };
    }
    const when =
      finalAt === undefined ? undefined : localMoment(finalAt, timeZone);
    return {
      text: [
        `Онлайн-торги закончились. Продано лотов: ${notice.soldCount}. В финал идут: ${notice.heldCount}.`,
        "",
        ...(when === undefined ? [] : [`Финал ориентировочно ${when}.`]),
        "Состав финала объявят отдельным сообщением, тогда же откроется раунд 2 прогнозов.",
      ].join("\n"),
      rows: [],
    };
  }
  if (notice.kind === "lot-sold-in-final") {
    const title = quoted(lots.get(notice.lotId)?.title, LINE_TITLE_LIMIT);
    return {
      text: `Лот${title === undefined ? "" : ` ${title}`} продан в финале за ${money(notice.price)}. Ты на него ставил.`,
      rows: refused.has(notice.lotId)
        ? []
        : [[{ kind: "lot", lotId: notice.lotId, text: toLotLabel }]],
    };
  }
  const own = new Set(notice.yourLotIds);
  const shown = shownLineup(notice);
  const hidden = notice.lineup.length - shown.length;
  const lead =
    own.size === 0
      ? "Объявлен состав финала аукциона:"
      : own.size === 1
        ? "Твой лот в финале аукциона. Состав финала:"
        : "Твои лоты в финале аукциона. Состав финала:";
  const text = [
    lead,
    "",
    ...shown.map((lot) => {
      const title =
        quoted(lots.get(lot.lotId)?.title, LINE_TITLE_LIMIT) ?? "Лот";
      const line = `• ${title} — ${money(lot.price)}`;
      return own.has(lot.lotId) ? `${line}, лот за тобой` : line;
    }),
    ...(hidden > 0 ? [`…и ещё лотов: ${hidden}.`] : []),
    "",
    "Раунд 2 прогнозов открыт — он закроется, когда начнётся финал.",
  ].join("\n");
  const rows: LotNoticeButton[][] = notice.yourLotIds
    .slice(0, OWN_LOT_BUTTON_LIMIT)
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
  return { text, rows };
}
