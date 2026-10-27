import type { RaffleView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import { parsePrize } from "./auction-console.js";
import type {
  AuctionConsoleCall,
  ExecuteResult,
  RafflePrizeChangeRequest,
} from "./types.js";

// Смена приза идущего розыгрыша (PER-737; ADR-066, дополнение 2026-10-25):
// приз розыгрыш копирует при открытии онлайн-недели, и «Сроки недели» его
// больше не меняют. Пульт спрашивает новый текст, показывает «было → станет»
// и отдаёт Auction. Своего состояния нет: аукцион едет в кнопке, текст — в
// экране подтверждения, ключ рождается на нажатие «Да». Право решает Auction у
// Meetups; пускает сюда край — держателя права вести аукцион.

export function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

export const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
export const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};
export const meetupCancelled: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "meetup-cancelled",
};

/** Приз меняется, пока у розыгрыша нет итога и он будет. */
export function prizeChangeable(raffle: RaffleView): boolean {
  switch (raffle.status) {
    case "open":
    case "closing":
    case "awaiting-beacon":
    case "awaiting-winner":
      return true;
    case "drawn":
    case "no-tickets":
    case "not-held":
    case "cancelled":
      return false;
    default: {
      const _exhaustive: never = raffle.status;
      return _exhaustive;
    }
  }
}

/**
 * Розыгрыш, приз которого ещё меняется (PER-737), — его же правило у фото
 * приза (PER-773). Пульт решает право и существование аукциона, розыгрыш —
 * можно ли менять приз. Читаются параллельно, как у итога розыгрыша.
 * Розыгрыш, приз которого уже не меняется, — исход вместо вопроса: кнопка
 * устарела.
 */
export async function editableRaffle(
  consoles: AuctionConsoles,
  request: AuctionConsoleCall,
): Promise<
  | { kind: "ok"; raffle: RaffleView }
  | { kind: "refused"; result: ExecuteResult }
  | { kind: "settled"; note: "no-raffle" | "already-drawn" | "without-result" }
> {
  const meta = rpcMeta(request);
  const [console, found] = await Promise.all([
    consoles.getAuctionConsole(request.identity, request.auctionId, meta),
    consoles.consoleRaffle(request.identity, request.auctionId, meta),
  ]);
  switch (console.kind) {
    case "ok":
      break;
    case "not-administrator":
    case "meetup-not-found":
      return { kind: "refused", result: notAdministrator };
    case "auction-not-found":
      return { kind: "refused", result: auctionNotFound };
    default:
      return { kind: "refused", result: failed(console) };
  }
  if (found.kind !== "ok") return { kind: "refused", result: failed(found) };
  const raffle = found.raffle;
  if (raffle === undefined) return { kind: "settled", note: "no-raffle" };
  if (prizeChangeable(raffle)) return { kind: "ok", raffle };
  return {
    kind: "settled",
    note: raffle.status === "drawn" ? "already-drawn" : "without-result",
  };
}

export function createRafflePrizeChange(consoles: AuctionConsoles) {
  type Changeable =
    | { kind: "ok"; raffle: RaffleView }
    | { kind: "refused"; result: ExecuteResult };

  async function changeable(
    request: RafflePrizeChangeRequest,
  ): Promise<Changeable> {
    const found = await editableRaffle(consoles, request);
    if (found.kind !== "settled") return found;
    return {
      kind: "refused",
      result: {
        kind: "raffle-prize-change-outcome",
        auctionId: request.auctionId,
        note: found.note,
      },
    };
  }

  async function change(
    request: Extract<
      RafflePrizeChangeRequest,
      { intent: "change-raffle-prize" }
    >,
  ): Promise<ExecuteResult> {
    const { auctionId } = request;
    const answer = await consoles.changeRafflePrize(
      request.identity,
      { auctionId, prize: request.prize, opId: request.opId },
      rpcMeta(request),
    );
    switch (answer.kind) {
      // Повтор того же ключа Auction отвечает розыгрышем как есть: исход
      // называет приз из ответа, а не из экрана.
      case "ok":
        return {
          kind: "raffle-prize-change-outcome",
          auctionId,
          note: "changed",
          prize: answer.raffle.prize ?? request.prize,
        };
      // Текст из экрана подтверждения край уже проверил теми же правилами;
      // отказ Auction по тексту — вопрос заново.
      case "prize-blank":
      case "prize-too-long":
        return {
          kind: "raffle-prize-change-ask",
          auctionId,
          error: answer.kind,
        };
      case "already-drawn":
        return {
          kind: "raffle-prize-change-outcome",
          auctionId,
          note: "already-drawn",
        };
      case "without-result":
        return {
          kind: "raffle-prize-change-outcome",
          auctionId,
          note: "without-result",
        };
      case "raffle-not-found":
        return {
          kind: "raffle-prize-change-outcome",
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

  return async (request: RafflePrizeChangeRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "ask-raffle-prize-change": {
        const found = await changeable(request);
        if (found.kind === "refused") return found.result;
        const { prize } = found.raffle;
        return {
          kind: "raffle-prize-change-ask",
          auctionId: request.auctionId,
          ...(prize === undefined ? {} : { prize }),
        };
      }
      // Ответ сверяется с розыгрышем, прочитанным заново: «было» на
      // подтверждении — приз сейчас, а не в момент вопроса.
      case "pick-raffle-prize-change": {
        const found = await changeable(request);
        if (found.kind === "refused") return found.result;
        const { prize } = found.raffle;
        const parsed = parsePrize(request.value);
        if (parsed.kind === "rejected") {
          return {
            kind: "raffle-prize-change-ask",
            auctionId: request.auctionId,
            ...(prize === undefined ? {} : { prize }),
            error: parsed.error,
          };
        }
        return {
          kind: "raffle-prize-change-confirm",
          auctionId: request.auctionId,
          ...(prize === undefined ? {} : { before: prize }),
          after: parsed.prize,
        };
      }
      case "change-raffle-prize":
        return change(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
