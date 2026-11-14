import { InlineKeyboard } from "grammy";
import { finalFeedLine } from "../../../auction-standing.js";
import type { AuctionPort, FeedItem } from "../../../auction-ui/index.js";
import { truncate } from "../../../core/format.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type { Person } from "../application/types.js";
import { type AuctionScreens, viewerOf } from "../auction/port.js";
import { lotStartLink } from "./lot-deep-link.js";
import { oneLine } from "./screens/auction-bid.js";
import { escapeHtml } from "./screens/kit.js";

// Лот живого финала для шёпота в чате сообщества (PER-685; ADR-078, п. 3–4):
// пока идёт финал — лот на торгах, его цена и вход в бот на карточку лота.
// Шёпот несёт только то, что человек и так видит в боте: название и цену,
// без имени лидера. Ставки из чата нет.

export type FinalLot =
  // Финала сейчас нет: нет идущего аукциона, он ещё не дошёл до финала или
  // скрыт — скрытое шёпотом не уходит даже его ведущему (ADR-078, п. 4).
  | { kind: "no-final" }
  // Финал идёт, а лота на торгах нет: ведущий готовит следующий.
  | { kind: "between-lots" }
  | { kind: "lot"; lot: FeedItem }
  // Auction не ответил: `error` — для записи границы.
  | { kind: "unavailable"; error: string };

/**
 * Читает лот финала правами самого человека: идущий аукцион — тот же
 * `currentAuction`, что у меню и «Событий», а лот на торгах — `active_lot_id`
 * его снимка (PER-639). Торги открыты не больше чем у одного аукциона
 * (PER-603), поэтому финал — один.
 */
export async function readFinalLot(input: {
  auctions: Pick<AuctionScreens, "currentAuction">;
  lots: Pick<AuctionPort, "getLot">;
  person: Person;
  meta?: RpcMetadata;
}): Promise<FinalLot> {
  const current = await input.auctions.currentAuction(input.person, input.meta);
  if (current.kind !== "ok") {
    return { kind: "unavailable", error: current.kind };
  }
  const auction = current.auction;
  if (
    auction === undefined ||
    auction.stage !== "in-final" ||
    auction.hidden === true
  ) {
    return { kind: "no-final" };
  }
  const lotId = auction.lineup?.activeLotId;
  if (lotId === undefined) return { kind: "between-lots" };
  try {
    const lot = await input.lots.getLot({
      viewer: viewerOf(input.person),
      lotId,
    });
    return {
      kind: "lot",
      lot: {
        lotId: lot.lotId,
        ...(lot.card === undefined ? {} : { title: lot.card.title }),
        status: lot.status,
      },
    };
  } catch (cause) {
    return {
      kind: "unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const untitled = "Лот без названия";
const titleLimit = 120;
export const openInBotLabel = "Открыть в боте";
export const noFinalText = "Финала аукциона сейчас нет.";
export const finalUnavailableText =
  "Не получилось узнать, что идёт в финале. Повтори команду через минуту.";

export type FinalLotWhisper = {
  text: string;
  format: "HTML";
  keyboard?: InlineKeyboard;
};

/**
 * Текст шёпота — строка шапки ленты в финале (`finalFeedLine`, PER-639):
 * название, цена и сумма, которую объявил ведущий. Имени лидера в ней нет.
 * Кнопка — ссылка `l_<токен>` в бот хаба: карточку лота открывает личка, а
 * не чат.
 */
export function finalLotWhisper(
  final: FinalLot,
  hubBotUsername: string,
): FinalLotWhisper {
  switch (final.kind) {
    case "no-final":
      return { text: noFinalText, format: "HTML" };
    case "unavailable":
      return { text: finalUnavailableText, format: "HTML" };
    case "between-lots":
      return { text: finalFeedLine(undefined, { title }), format: "HTML" };
    case "lot":
      return {
        text: finalFeedLine(final.lot, { title }),
        format: "HTML",
        keyboard: new InlineKeyboard().url(
          openInBotLabel,
          lotStartLink(hubBotUsername, final.lot.lotId),
        ),
      };
  }
}

function title(item: FeedItem): string {
  return escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit));
}
