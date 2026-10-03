import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, LotStatusView, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";

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
  const participantName = await nameOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: lot.auctionId,
    participantId: participantOf(lot.status),
  });
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

// Имя — подпись к цене, а не сам исход: отказ `GetDisplayNames` оставляет
// карточку без имени, но не прячет ни цену, ни исход. Так же карточка сходки
// в хабе переживает отказ ника автора (docs/services/telegram-bot.md). Отказ
// пишет в лог порт приложения: пакет логгера не держит.
async function nameOf(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
  participantId: string | undefined;
}): Promise<string | undefined> {
  if (input.participantId === undefined) return undefined;
  try {
    const names = await input.auction.getDisplayNames({
      viewer: input.viewer,
      auctionId: input.auctionId,
      participantIds: [input.participantId],
    });
    return names[input.participantId];
  } catch {
    return undefined;
  }
}
