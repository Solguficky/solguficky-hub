import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  RafflePrizePhotoResult,
} from "../auction/port.js";
import {
  auctionNotFound,
  editableRaffle,
  failed,
  meetupCancelled,
  notAdministrator,
} from "./raffle-prize-change.js";
import type { ExecuteResult, RafflePrizePhotoRequest } from "./types.js";

// Фото приза идущего розыгрыша (PER-773; хранение — PER-772): тем же правилом,
// что смена приза (PER-737), — пока итога нет. Пульт показывает, есть ли фото,
// спрашивает его ответом и отдаёт байты Auction; снятие — с подтверждением.
// Своего состояния нет: аукцион едет в кнопке, `photoId` выводит край из
// ответа с фото, ключ снятия рождается на «Да». Право решает Auction у
// Meetups; пускает сюда край — держателя права вести аукцион.

export function createRafflePrizePhoto(consoles: AuctionConsoles) {
  // Ответ команды: принятая — исход, отказ изображения — вопрос заново с
  // причиной, остальное — как у смены приза.
  function answered(
    request: RafflePrizePhotoRequest,
    answer: RafflePrizePhotoResult,
    accepted: "set" | "removed",
  ): ExecuteResult {
    const { auctionId } = request;
    switch (answer.kind) {
      case "ok":
        return {
          kind: "raffle-prize-photo-outcome",
          auctionId,
          note: accepted,
        };
      case "image-too-large":
        return {
          kind: "raffle-prize-photo-ask",
          auctionId,
          error: "image-too-large",
          maxBytes: answer.maxBytes,
        };
      case "unsupported-image":
        return {
          kind: "raffle-prize-photo-ask",
          auctionId,
          error: "unsupported-image",
        };
      // `photoId` выводится из самого ответа: тот же ключ с другими байтами —
      // дефект края, а не ответ человека.
      case "photo-conflict":
        return {
          kind: "dependency-rejected",
          reason: "invalid",
          cause: new Error("raffle prize photo id taken by other bytes"),
        };
      case "already-drawn":
        return {
          kind: "raffle-prize-photo-outcome",
          auctionId,
          note: "already-drawn",
        };
      case "without-result":
        return {
          kind: "raffle-prize-photo-outcome",
          auctionId,
          note: "without-result",
        };
      case "raffle-not-found":
        return {
          kind: "raffle-prize-photo-outcome",
          auctionId,
          note: "no-raffle",
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

  return async (request: RafflePrizePhotoRequest): Promise<ExecuteResult> => {
    const { auctionId } = request;
    switch (request.intent) {
      case "view-raffle-prize-photo":
      case "ask-raffle-prize-photo": {
        const found = await editableRaffle(consoles, request);
        if (found.kind === "refused") return found.result;
        if (found.kind === "settled") {
          return {
            kind: "raffle-prize-photo-outcome",
            auctionId,
            note: found.note,
          };
        }
        return request.intent === "view-raffle-prize-photo"
          ? {
              kind: "raffle-prize-photo",
              auctionId,
              hasPhoto: found.raffle.prizePhoto !== undefined,
            }
          : { kind: "raffle-prize-photo-ask", auctionId };
      }
      case "set-raffle-prize-photo":
        return answered(
          request,
          await consoles.setRafflePrizePhoto(
            request.identity,
            { auctionId, photoId: request.photoId, image: request.image },
            rpcMeta(request),
          ),
          "set",
        );
      case "remove-raffle-prize-photo":
        return answered(
          request,
          await consoles.removeRafflePrizePhoto(
            request.identity,
            { auctionId, opId: request.opId },
            rpcMeta(request),
          ),
          "removed",
        );
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
