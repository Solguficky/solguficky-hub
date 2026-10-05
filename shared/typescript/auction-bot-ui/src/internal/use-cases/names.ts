import type { AuctionPort, Viewer } from "../../ports.js";

// Имена участников — подпись к цене, а не сам исход: отказ `GetDisplayNames`
// оставляет экран без имён, но не прячет ни цену, ни исход. Так же карточка
// сходки в хабе переживает отказ ника автора (docs/services/hub-bot.md).
// Отказ пишет в лог порт приложения: пакет логгера не держит.
//
// Один вызов на экран: каждый идентификатор спрашивается один раз, а без
// участников Auction за именами не зовут.
export async function namesOf(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
  participantIds: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  const participantIds = [...new Set(input.participantIds)];
  if (participantIds.length === 0) return {};
  try {
    return await input.auction.getDisplayNames({
      viewer: input.viewer,
      auctionId: input.auctionId,
      participantIds,
    });
  } catch {
    return {};
  }
}
