import { BidSource } from "../../../gen/auction/v1/auction_pb.js";
import type {
  HistoryBid,
  HistoryRemoval,
  ListLotHistoryResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  BidOriginView,
  LotHistoryEntryView,
  LotHistoryPage,
} from "../../auction-ui/index.js";
import { moneyOf } from "./snapshot.js";

// Перевод страницы `auction.v1.ListLotHistory` в срез аукционного дерева. Запись
// вида, которого этот бот не знает, пропускается: контракт разрешает Auction
// добавлять виды записей, и старый бот обязан показать остальную хронологию.
// Ставка без суммы, способа или с неизвестным каналом — дефект соседа: перевод
// бросает, как и перевод снимка лота.
export function historyPageOf(page: ListLotHistoryResponse): LotHistoryPage {
  return {
    entries: page.entries.flatMap((entry): LotHistoryEntryView[] => {
      switch (entry.kind.case) {
        case "bid":
          return [bidOf(entry.sequence, entry.occurredAt, entry.kind.value)];
        case "removal":
          return [
            removalOf(entry.sequence, entry.occurredAt, entry.kind.value),
          ];
        case undefined:
          return [];
        default: {
          const _exhaustive: never = entry.kind;
          return _exhaustive;
        }
      }
    }),
    nextPageToken: page.nextPageToken,
  };
}

function bidOf(
  sequence: bigint,
  occurredAt: string,
  bid: HistoryBid,
): LotHistoryEntryView {
  if (bid.amount === undefined) throw new Error("history bid without amount");
  return {
    kind: "bid",
    sequence: Number(sequence),
    occurredAt,
    bidId: bid.bidId,
    participantId: bid.participantId,
    amount: moneyOf(bid.amount),
    origin: originOf(bid.origin),
    ...(bid.removed ? { removed: true as const } : {}),
  };
}

// Снятие участника (ADR-072): цена, с которой лот пошёл дальше, и лидер.
// Снятие без цены — дефект соседа, как ставка без суммы.
function removalOf(
  sequence: bigint,
  occurredAt: string,
  removal: HistoryRemoval,
): LotHistoryEntryView {
  if (removal.price === undefined) {
    throw new Error("history removal without price");
  }
  return {
    kind: "removal",
    sequence: Number(sequence),
    occurredAt,
    price: moneyOf(removal.price),
    ...(removal.leaderId === undefined ? {} : { leaderId: removal.leaderId }),
  };
}

function originOf(origin: HistoryBid["origin"]): BidOriginView {
  switch (origin.case) {
    case "manual":
      return { kind: "manual", source: sourceOf(origin.value.source) };
    case "proxy":
      return { kind: "proxy" };
    case undefined:
      throw new Error("history bid without origin");
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

function sourceOf(source: BidSource): "bot" | "floor" {
  switch (source) {
    case BidSource.BOT:
      return "bot";
    case BidSource.FLOOR:
      return "floor";
    default:
      throw new Error(`history bid with bid source ${source}`);
  }
}

// Чем перебита ставка получателя вести «перебили» (PER-840): хронология
// отдаёт источник ставки, а сама весть его не несёт. Ставка находится по цене
// из вести среди ставок не получателя. Две подходящие (после снятия участника
// цена могла повториться) или ни одной (запись ушла за предел чтения) —
// ответа нет: весть остаётся нейтральной, как до этой правки. Хронология идёт
// по возрастанию, и нужная ставка стоит ближе к концу: предел страниц у лота с
// очень длинной историей даёт тот же нейтральный ответ.
export function outbidOriginOf(
  entries: readonly LotHistoryEntryView[],
  minorUnits: number,
  recipientId: string,
): "proxy" | "manual" | undefined {
  const matching = entries.filter(
    (entry) =>
      entry.kind === "bid" &&
      entry.removed !== true &&
      entry.participantId !== recipientId &&
      entry.amount.minorUnits === minorUnits,
  );
  const [only] = matching;
  if (matching.length !== 1 || only?.kind !== "bid") return undefined;
  return only.origin.kind === "proxy" ? "proxy" : "manual";
}

// Страниц хронологии, которые весть готова прочитать: перебитие приходит на
// живой лот, а не на лот с тысячей ставок, и долгое чтение задержало бы доставку.
const OUTBID_HISTORY_PAGES = 20;

export async function readOutbidOrigin(
  readPage: (pageToken: string) => Promise<ListLotHistoryResponse>,
  minorUnits: number,
  recipientId: string,
): Promise<"proxy" | "manual" | undefined> {
  const entries: LotHistoryEntryView[] = [];
  let pageToken = "";
  for (let pages = 0; pages < OUTBID_HISTORY_PAGES; pages += 1) {
    const page = historyPageOf(await readPage(pageToken));
    entries.push(...page.entries);
    if (page.nextPageToken === "") {
      return outbidOriginOf(entries, minorUnits, recipientId);
    }
    pageToken = page.nextPageToken;
  }
  return undefined;
}
