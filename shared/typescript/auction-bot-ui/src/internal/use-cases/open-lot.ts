import { encodeAuctionCallback, MAX_FEED_PAGE } from "../../callback-data.js";
import type { AuctionPort, LotStatusView, Viewer } from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { namesOf } from "./names.js";

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Войти в него можно только через `handleAuctionUpdate`, после шлюза.
//
// `page` — страница ленты, с которой открыли карточку: на неё ведёт «Назад».
export async function openLot(input: {
  auction: AuctionPort;
  viewer: Viewer;
  lotId: string;
  page: number;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
  });
  const participantId = participantOf(lot.status);
  const names = await namesOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: lot.auctionId,
    participantIds: participantId === undefined ? [] : [participantId],
  });
  const participantName =
    participantId === undefined ? undefined : names[participantId];
  // Хронология открывается на последней странице — со свежими ставками:
  // страницу за пределом юзкейс хронологии прижимает к последней.
  const history: AuctionButton[][] = hasTraded(lot.status)
    ? [
        [
          {
            action: "lot.history",
            callbackData: encodeAuctionCallback({
              kind: "history",
              lotId: lot.lotId,
              page: input.page,
              historyPage: MAX_FEED_PAGE,
            }),
          },
        ],
      ]
    : [];
  return {
    blocks: [
      {
        kind: "lot",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        version: lot.version,
        ...(lot.card === undefined ? {} : { card: lot.card }),
        ...(lot.nextPrice === undefined ? {} : { nextPrice: lot.nextPrice }),
        ...(lot.fixedStep === undefined ? {} : { fixedStep: lot.fixedStep }),
        status: lot.status,
        ...(participantName === undefined ? {} : { participantName }),
      },
    ],
    keyboard: [
      [
        {
          action: "lot.refresh",
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page: input.page,
          }),
        },
      ],
      ...history,
      [
        {
          action: "lot.back",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: lot.auctionId,
            page: input.page,
          }),
        },
      ],
    ],
  };
}

// Чьё имя нужно экрану: лидера в торгах или победителя проданного лота. У
// закрытого без продажи и снятого лота участника нет, и Auction за именем не
// зовут.
function participantOf(status: LotStatusView): string | undefined {
  switch (status.kind) {
    case "trading":
    case "held":
      return status.leaderId;
    case "sold":
      return status.winnerId;
    case "draft":
    case "scheduled":
    case "unsold":
    case "withdrawn":
      return undefined;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Хронология есть у лота, который открывался к торгам: у черновика и
// запланированного ставок быть не может. Снятый лот мог быть снят и из торгов,
// поэтому кнопка у него остаётся, а пустая хронология говорит сама за себя.
function hasTraded(status: LotStatusView): boolean {
  switch (status.kind) {
    case "trading":
    case "held":
    case "sold":
    case "unsold":
    case "withdrawn":
      return true;
    case "draft":
    case "scheduled":
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
