import { encodeAuctionCallback, MAX_FEED_PAGE } from "../../callback-data.js";
import type { AuctionPort, LotHistoryEntryView, Viewer } from "../../ports.js";
import type {
  AuctionButton,
  AuctionScreenBody,
  HistoryItem,
} from "../../screen.js";
import { collectPages } from "./collect-pages.js";
import { namesOf } from "./names.js";

// Строк на странице хронологии — как у ленты: восемь строк содержимого на
// экран (дизайн-код, «Клавиатура»).
export const HISTORY_PAGE_SIZE = 8;

const MAX_HISTORY_ENTRIES = HISTORY_PAGE_SIZE * (MAX_FEED_PAGE + 1);

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
//
// Хронология лота — общедоступная цепочка его ставок для спора (RFC-007,
// «Спор»). Порядок — журнала: Auction отдаёт записи по возрастанию `sequence`,
// и край его не пересортировывает. Страница за пределом хронологии открывает
// последнюю, поэтому кнопка с карточки ведёт на свежие ставки.
//
// `page` — страница ленты, с которой открыта карточка: её несёт возврат на
// карточку, чтобы возврат с карточки попал туда же.
export async function openHistory(input: {
  auction: AuctionPort;
  viewer: Viewer;
  lotId: string;
  page: number;
  historyPage: number;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
  });
  const entries = await collectPages<LotHistoryEntryView>({
    what: "lot history",
    maxItems: MAX_HISTORY_ENTRIES,
    fetch: async (pageToken) => {
      const page = await input.auction.listLotHistory({
        viewer: input.viewer,
        lotId: input.lotId,
        pageToken,
      });
      return { items: page.entries, nextPageToken: page.nextPageToken };
    },
  });
  const pageCount = Math.max(1, Math.ceil(entries.length / HISTORY_PAGE_SIZE));
  const historyPage = Math.min(input.historyPage, pageCount - 1);
  // Страницы режутся от свежего конца: последняя — всегда восемь свежих
  // ставок, а неполной остаётся самая ранняя. Иначе кнопка с карточки при
  // девяти ставках открыла бы страницу из одной.
  const end =
    entries.length - (pageCount - 1 - historyPage) * HISTORY_PAGE_SIZE;
  const shown = entries.slice(Math.max(0, end - HISTORY_PAGE_SIZE), end);
  const names = await namesOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: lot.auctionId,
    participantIds: shown.map((entry) => entry.participantId),
  });
  const historyButton = (target: number) =>
    encodeAuctionCallback({
      kind: "history",
      lotId: lot.lotId,
      page: input.page,
      historyPage: target,
    });
  const paging: AuctionButton[] = [
    ...(historyPage > 0
      ? [
          {
            action: "history.prev" as const,
            callbackData: historyButton(historyPage - 1),
          },
        ]
      : []),
    ...(historyPage < pageCount - 1
      ? [
          {
            action: "history.next" as const,
            callbackData: historyButton(historyPage + 1),
          },
        ]
      : []),
  ];
  return {
    blocks: [
      {
        kind: "history",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...(lot.card === undefined ? {} : { title: lot.card.title }),
        page: historyPage,
        pageCount,
        entries: shown.map((entry) => item(entry, names[entry.participantId])),
      },
    ],
    keyboard: [
      ...(paging.length > 0 ? [paging] : []),
      [
        {
          action: "history.back",
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page: input.page,
          }),
        },
      ],
    ],
  };
}

function item(
  entry: LotHistoryEntryView,
  participantName: string | undefined,
): HistoryItem {
  return {
    kind: "bid",
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    amount: entry.amount,
    origin: entry.origin,
    ...(participantName === undefined ? {} : { participantName }),
  };
}
