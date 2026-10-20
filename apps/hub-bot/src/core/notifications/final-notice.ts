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

// Анонс финала аукциона (PER-477, PER-478) — состав и старт живого финала тем,
// кто вёл лот аукциона. У двух ботов он один, по кругу получателя, как вести о
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
  | { kind: "final-started"; auctionId: string };

const finalNoticeKinds: ReadonlySet<string> = new Set<FinalNotice["kind"]>([
  "final-lineup",
  "final-started",
]);

/** Анонс финала среди веток канала: его рисует общий рендер. */
export function isFinalNotice<C extends { kind: string }>(
  content: C,
): content is Extract<C, FinalNotice> {
  return finalNoticeKinds.has(content.kind);
}

type FinalBranch = Extract<
  Notification["type"],
  { case: "auctionFinalLineup" | "auctionFinalStarted" }
>;

// Факт — ввод соседа: пустой состав, лот или аукцион не в канонической форме,
// повтор лота в составе, цена без валюты и «свой» лот вне состава — дефект
// издателя, и разбор отвечает `undefined`, как у остальных веток. Свои лоты
// разбор ставит в порядок состава сам: кнопки идут в порядке финала, а не
// провода.
export function finalNoticeOf(type: FinalBranch): FinalNotice | undefined {
  const auctionId = canonical(type.value.auctionId);
  if (auctionId === undefined) return undefined;
  if (type.case === "auctionFinalStarted") {
    return { kind: "final-started", auctionId };
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

// Сборка анонса. Весть о торгах: без права `place-bids` она не уходит, как
// вести о лотах. Недоступный Auction роняет только названия — строка состава
// остаётся с ценой; лот, который Auction окончательно не отдал, остаётся
// строкой без названия и без кнопки, а отказ пишется в лог.
export function createFinalNoticeRender({
  reads,
  onTitleMissing,
}: Omit<LotNoticeRenderOptions, "frequencyButton" | "timeZone">): (
  notice: FinalNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
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
    if (notice.kind === "final-lineup") {
      const { recipientId, requestId } = context;
      const lotIds = shownLineup(notice).map((lot) => lot.lotId);
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
};

// Строка «Объявлен состав финала» или «Твой лот в финале», пустая строка и
// строки состава «• «Лот» — цена» в порядке финала; свой лот — с «лот за
// тобой», как в сводке. Под составом — ряд на каждый свой лот с его названием:
// карточка приходит новым сообщением. У простого анонса и старта финала кнопок
// нет (решение владельца 19 октября 2026 года, PER-478).
export function renderFinalNotice(
  notice: FinalNotice,
  { lots, refused = new Set() }: FinalNoticeRenderInput,
): LotNoticeView {
  if (notice.kind === "final-started") {
    return { text: "Начался финал аукциона.", rows: [] };
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
