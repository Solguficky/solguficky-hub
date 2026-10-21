import type { StepWindowStarted } from "../../../gen/notifications/v1/notifications_pb.js";
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
  type LotNoticeReads,
  type LotNoticeView,
  localTime,
  type NoticeMoney,
  quoted,
  toMoney,
} from "./lot-notice.js";

// Начало окна «Счастливых часов» на отмеченных лотах (ADR-047, дополнение
// 2026-10-12, «Сообщение о начале окна»; PER-614) — весть каждому, у кого на
// момент срабатывания есть отметка избранного на лоте окна. У двух ботов она
// одна: участнику её доставляет бот хаба, гостю — бот аукциона (ADR-064,
// п. 16). Здесь разбор ветки, текст и ряды кнопок; данные кнопок каждая
// поверхность кодирует своим следом лота, как у вестей о лотах.
//
// Право `place-bids` канал спрашивает, как у вестей о торгах: кнопка ведёт в
// карточку лота, а Auction отдаёт лот только зрителю с этим правом. Настройка
// перебитий повод не трогает, и категории у него нет: выключить его — снять
// отметку, поэтому кнопки частоты под этой вестью нет (ADR-047).

export type StepWindowLot = {
  lotId: string;
  // Конец окна своего лота: RFC 3339, тот же формат, что у дедлайна.
  until: string;
  // Шаг, в силе в окне этого лота: у лотов одного окна он разным быть может.
  step: NoticeMoney;
};

export type StepWindowNotice = {
  kind: "step-window-started";
  auctionId: string;
  // Лоты окна получателя; каждый со своим шагом и концом окна.
  lots: readonly StepWindowLot[];
};

const stepWindowNoticeKinds: ReadonlySet<string> = new Set<
  StepWindowNotice["kind"]
>(["step-window-started"]);

/** Начало окна среди веток канала: его рисует общий рендер. */
export function isStepWindowNotice<C extends { kind: string }>(
  content: C,
): content is Extract<C, StepWindowNotice> {
  return stepWindowNoticeKinds.has(content.kind);
}

// Факт — ввод соседа: пустой список лотов, аукцион или лот не в канонической
// форме, шаг без валюты, начало или конец окна не как момент и конец окна раньше
// его начала — дефект издателя, и разбор отвечает `undefined`, как у остальных
// веток. Повтор лота в списке — тоже: у каждого лота окно одно.
export function stepWindowNoticeOf(
  value: StepWindowStarted,
): StepWindowNotice | undefined {
  const auctionId = canonical(value.auctionId);
  if (auctionId === undefined || value.lots.length === 0) return undefined;
  const startsAt = instantOf(value.startsAt);
  if (startsAt === undefined) return undefined;
  const lots: StepWindowLot[] = [];
  for (const lot of value.lots) {
    const lotId = canonical(lot.lotId);
    const step = toMoney(lot.step);
    const until = instantOf(lot.until);
    if (
      lotId === undefined ||
      step === undefined ||
      until === undefined ||
      until <= startsAt
    ) {
      return undefined;
    }
    lots.push({ lotId, until: lot.until, step });
  }
  if (new Set(lots.map((lot) => lot.lotId)).size !== lots.length)
    return undefined;
  return { kind: "step-window-started", auctionId, lots };
}

// Момент окна — RFC 3339 в UTC, как пишет его издатель
// (`notifications.v1.NotificationFacts.Instant`): «2026-10-21T21:00:00Z» или с
// долями секунды. `Date.parse` берёт и «2026-10-21», и «Oct 21, 2026», а
// выдуманное время в тексте читалось бы как срок окна.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// Момент в миллисекундах: строгий вид и число раз — иначе это не момент.
function instantOf(value: string): number | undefined {
  if (!INSTANT.test(value)) return undefined;
  const moment = Date.parse(value);
  return Number.isFinite(moment) ? moment : undefined;
}

export type StepWindowRenderInput = {
  // Лоты, о которых канал знает: название.
  lots: ReadonlyMap<string, LotInfo>;
  // Лоты, которые Auction окончательно отказался отдать: кнопка к ним
  // упёрлась бы в тот же отказ.
  refused?: ReadonlySet<string>;
  // Пояс сообщества: конец окна человек читает по своему часовому поясу.
  timeZone: string;
};

// Строка окна и подпись кнопки короче названия лота: строка несёт и шаг, и
// конец окна, а кнопка — только лот.
const LINE_TITLE_LIMIT = 60;
const BUTTON_TITLE_LIMIT = 32;
const toLotLabel = "К лоту";

// Сборка вести. Право `place-bids` спрашивается, как у вестей о торгах: без
// него кнопка упёрлась бы в тот же отказ. Недоступный Auction названий не
// роняет: весть ценна вовремя, а название видно в карточке по кнопке. Лот,
// который Auction окончательно не отдал, остаётся строкой без названия и без
// кнопки, а отказ пишется в лог — остальные лоты от этого не страдают.
export function createStepWindowNoticeRender({
  reads,
  onTitleMissing,
  timeZone,
}: {
  reads: LotNoticeReads | undefined;
  onTitleMissing: (cause: unknown, requestId?: string) => void;
  timeZone: string;
}): (
  notice: StepWindowNotice,
  context: RenderContext,
) => Promise<RenderResult<LotNoticeView>> {
  return async (notice, context) => {
    const lots = new Map<string, LotInfo>();
    const refused = new Set<string>();
    if (reads === undefined) {
      return {
        kind: "ready",
        message: renderStepWindowNotice(notice, { lots, refused, timeZone }),
      };
    }
    const { recipientId, requestId } = context;
    const stop = await checkPlaceBids(reads, context);
    if (stop !== undefined) return stop;
    const lotIds = shownLots(notice).map((lot) => lot.lotId);
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
    return {
      kind: "ready",
      message: renderStepWindowNotice(notice, { lots, refused, timeZone }),
    };
  };
}

// Лотов окна может быть больше, чем показывает сообщение: названия читаем
// только у показанных, как у сводки (`lot-notice.ts`) и анонса состава
// (`final-notice.ts`).
function shownLots(notice: StepWindowNotice): readonly StepWindowLot[] {
  return notice.lots.slice(0, DIGEST_LOT_LIMIT);
}

// Вид вести: первая строка, пустая строка и строки «• «Лот» — шаг … до …» по
// лоту окна получателя; под ними — ряд на каждый лот с его названием. Название
// лота в факте нет — канал читает его у Auction, как у остальных вестей о
// лотах. Лотов не больше десяти: окно может накрыть больше, а сообщение
// Telegram — 4096 знаков.
export function renderStepWindowNotice(
  notice: StepWindowNotice,
  { lots, refused = new Set(), timeZone }: StepWindowRenderInput,
): LotNoticeView {
  const shown = shownLots(notice);
  const hidden = notice.lots.length - shown.length;
  const text = [
    "Счастливые часы начались:",
    "",
    ...shown.map((lot) =>
      windowLine(lot, lots.get(lot.lotId)?.title, timeZone),
    ),
    ...(hidden > 0 ? [`…и ещё лотов: ${hidden}.`] : []),
  ].join("\n");
  const rows: LotNoticeButton[][] = shown
    .filter((lot) => !refused.has(lot.lotId))
    .map((lot) => {
      const title = lots.get(lot.lotId)?.title;
      return [
        {
          kind: "lot",
          lotId: lot.lotId,
          text:
            title === undefined || title === ""
              ? toLotLabel
              : truncate(title, BUTTON_TITLE_LIMIT),
        },
      ];
    });
  return { text, rows };
}

// Строка окна: название лота, шаг и конец окна по часам сообщества. Название
// обрезается, без названия строка начинается с «Лот».
function windowLine(
  lot: StepWindowLot,
  title: string | undefined,
  timeZone: string,
): string {
  const name = quoted(title, LINE_TITLE_LIMIT) ?? "Лот";
  const until = localTime(lot.until, timeZone);
  return `• ${name} — шаг ${money(lot.step)}${
    until === undefined ? "" : ` до ${until}`
  }`;
}
