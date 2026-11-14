import { Code, ConnectError } from "@connectrpc/connect";
import { finalFeedLine } from "../../../auction-standing.js";
import type { AuctionPort, FeedItem } from "../../../auction-ui/index.js";
import type { FailureCategory } from "../../../core/failures.js";
import { truncate } from "../../../core/format.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type { Person } from "../application/types.js";
import { type AuctionScreens, viewerOf } from "../auction/port.js";
import {
  openBotLabel,
  openBotLink,
  type WhisperCommand,
  type WhisperFrame,
} from "./community-whisper.js";
import {
  dependencyCategory,
  grpcFailureCategory,
  unavailableCategory,
} from "./failure-category.js";
import { lotStartLink } from "./lot-deep-link.js";
import { oneLine } from "./screens/auction-bid.js";
import { escapeHtml, screenText } from "./screens/kit.js";

// `/lot` в чате сообщества (PER-685; развилка D-2 плана эпика PER-679): пока
// идёт живой финал — лот на торгах и его цена шёпотом и ссылка в бот хаба на
// карточку лота. Шёпот несёт только то, что человек и так видит в боте:
// название и цену, без имени лидера (ADR-078, п. 4). Ставки из чата нет.

export type FinalLot =
  // Финала сейчас нет: нет идущего аукциона, он ещё не дошёл до финала или
  // скрыт — скрытое шёпотом не уходит даже его ведущему (ADR-078, п. 4).
  | { kind: "no-final" }
  // Финал идёт, а лота на торгах нет: ведущий готовит следующий.
  | { kind: "between-lots" }
  | { kind: "lot"; lot: FeedItem }
  // Auction не ответил: причина — для записи границы.
  | {
      kind: "unavailable";
      category: FailureCategory;
      error: string;
      grpcCode?: string;
    };

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
    return {
      kind: "unavailable",
      category: dependencyCategory(current.kind),
      error: `current auction ${current.kind}`,
    };
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
    const error = cause instanceof Error ? cause.message : String(cause);
    return cause instanceof ConnectError
      ? {
          kind: "unavailable",
          category: grpcFailureCategory(Code[cause.code]),
          error,
          grpcCode: Code[cause.code],
        }
      : { kind: "unavailable", category: unavailableCategory(cause), error };
  }
}

const title = "Лот финала";
const untitled = "Лот без названия";
const titleLimit = 120;
export const openLotLabel = "Открыть в боте";
export const noFinalText = "Финала аукциона сейчас нет.";

/**
 * Кадр шёпота. Строка лота — шапка ленты в финале (`finalFeedLine`, PER-639):
 * название, цена и сумма, которую объявил ведущий; имени лидера в ней нет.
 * Ссылка `l_<токен>` ведёт в бот хаба на карточку лота. Без лота на торгах
 * шёпот ведёт в бот той же «Открыть бота», что у `/meetups`: держателю права
 * хаба шёпот всегда несёт вход в бот (ADR-078, п. 3).
 */
export function lotWhisperFrame(
  final: Exclude<FinalLot, { kind: "unavailable" }>,
  botUsername: string,
): WhisperFrame {
  const openBot = [{ label: openBotLabel, url: openBotLink(botUsername) }];
  switch (final.kind) {
    case "no-final":
      return {
        id: "whisper-lot",
        text: screenText(title, noFinalText),
        links: openBot,
      };
    case "between-lots":
      return {
        id: "whisper-lot",
        text: screenText(title, finalFeedLine(undefined, { title: lotTitle })),
        links: openBot,
      };
    case "lot":
      return {
        id: "whisper-lot",
        text: screenText(title, finalFeedLine(final.lot, { title: lotTitle })),
        links: [
          {
            label: openLotLabel,
            url: lotStartLink(botUsername, final.lot.lotId),
          },
        ],
      };
  }
}

function lotTitle(item: FeedItem): string {
  return escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit));
}

/** Запись реестра шёпота: только у бота с Auction (D-2 плана эпика). */
export function lotWhisper(auction: AuctionScreens): WhisperCommand {
  return {
    useCase: "view_auction",
    async answer({ person, meta, botUsername }) {
      const final = await readFinalLot({
        auctions: auction,
        lots: auction.screenPorts(meta).auction,
        person,
        meta,
      });
      if (final.kind === "unavailable") {
        return {
          kind: "failed",
          message: "final lot unavailable",
          category: final.category,
          error: final.error,
          ...(final.grpcCode === undefined ? {} : { grpcCode: final.grpcCode }),
        };
      }
      return { kind: "frame", frame: lotWhisperFrame(final, botUsername) };
    },
  };
}
