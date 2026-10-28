import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type { ExecuteResult, PromoVideoRequest } from "./types.js";

// Промо-видео аукциона (PER-774): держатель права вести аукцион прикрепляет
// одно видео, заменяет его и убирает. Видео — пост чата медиа ботов (PER-775),
// который публикует край, а Auction хранит только номер поста (PER-781).
// Своего состояния нет: экран читает пульт, а команда одна — `SetPromoVideo`
// с ключом, рождённым на ответ с видео и на «Да» снятия. Право решает Auction
// у Meetups; пускает сюда край — держателя права вести аукцион.

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};
const meetupCancelled: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "meetup-cancelled",
};

export function createPromoVideo(
  consoles: Pick<AuctionConsoles, "getAuctionConsole" | "setPromoVideo">,
) {
  return async (request: PromoVideoRequest): Promise<ExecuteResult> => {
    const { auctionId } = request;
    switch (request.intent) {
      case "view-promo-video": {
        const found = await consoles.getAuctionConsole(
          request.identity,
          auctionId,
          rpcMeta(request),
        );
        switch (found.kind) {
          case "ok":
            return {
              kind: "promo-video",
              auctionId,
              video: found.console.promoVideo !== undefined,
            };
          case "not-administrator":
          case "meetup-not-found":
            return notAdministrator;
          case "auction-not-found":
            return auctionNotFound;
          default:
            return failed(found);
        }
      }
      case "set-promo-video": {
        const answer = await consoles.setPromoVideo(
          request.identity,
          {
            auctionId,
            opId: request.opId,
            ...(request.postId === undefined ? {} : { postId: request.postId }),
          },
          rpcMeta(request),
        );
        switch (answer.kind) {
          case "ok":
            return {
              kind: "promo-video-outcome",
              auctionId,
              note: request.postId === undefined ? "removed" : "set",
            };
          case "not-administrator":
          case "meetup-not-found":
            return notAdministrator;
          case "meetup-cancelled":
            return meetupCancelled;
          case "auction-not-found":
            return auctionNotFound;
          default:
            return failed(answer);
        }
      }
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
