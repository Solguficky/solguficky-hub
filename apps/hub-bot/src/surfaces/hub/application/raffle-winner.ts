import type {
  RaffleTicketView,
  RaffleView,
} from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type {
  ExecuteResult,
  RaffleWinnerAskError,
  RaffleWinnerRequest,
} from "./types.js";

// Итог розыгрыша вручную (PER-727; ADR-066, дополнение 2026-10-24): после
// закрытия регистрации пул ждёт, когда администратор назовёт победителя. Пульт
// показывает список билетов — его администратор вносит в колесо на внешнем
// сайте, — спрашивает номер выигравшего билета, подтверждает его с именем и
// отдаёт Auction. Своего состояния нет: аукцион и номер едут в кнопке, ключ
// рождается на нажатие «Да». Право решает Auction у Meetups; пускает сюда
// край — держателя права вести аукцион.

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

export type WinnerTicketResult =
  | { kind: "ok"; ticket: number }
  | { kind: "rejected"; error: RaffleWinnerAskError };

/**
 * Номер выигравшего билета: целое от 1 до числа билетов пула. Знак «№» или
 * «#» впереди принимается — так номер стоит в списке, который администратор
 * копирует в колесо.
 */
export function parseWinnerTicket(
  raw: string,
  tickets: number,
): WinnerTicketResult {
  const match = /^[№#]?\s*(\d{1,9})$/.exec(raw.trim());
  if (match === null) return { kind: "rejected", error: "winner-format" };
  const ticket = Number(match[1]);
  return ticket >= 1 && ticket <= tickets
    ? { kind: "ok", ticket }
    : { kind: "rejected", error: "winner-range" };
}

// Билет пула с именем, если оно есть: имя, стёртое через 30 дней, оставляет
// один номер.
function ticketOf(
  raffle: RaffleView | undefined,
  number: number,
): RaffleTicketView {
  return raffle?.tickets.find((each) => each.number === number) ?? { number };
}

export function createRaffleWinner(consoles: AuctionConsoles) {
  type Awaiting =
    | { kind: "ok"; raffle: RaffleView }
    | { kind: "refused"; result: ExecuteResult };

  // Пульт решает право и существование аукциона, розыгрыш — что итога ждут.
  // Читаются параллельно: розыгрыш без права не показывается, но и не
  // ждёт пульта. Розыгрыш, который итога не ждёт, — исход вместо экрана:
  // кнопка устарела, и исход называет, что с розыгрышем.
  async function awaiting(request: RaffleWinnerRequest): Promise<Awaiting> {
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
    const outcome = (
      result: Extract<ExecuteResult, { kind: "raffle-winner-outcome" }>,
    ): Awaiting => ({ kind: "refused", result });
    if (raffle === undefined) {
      return outcome({
        kind: "raffle-winner-outcome",
        auctionId: request.auctionId,
        note: "no-raffle",
      });
    }
    if (raffle.status === "awaiting-winner") return { kind: "ok", raffle };
    const winning = raffle.reveal?.winningTicket;
    return outcome(
      raffle.status === "drawn" && winning !== undefined
        ? {
            kind: "raffle-winner-outcome",
            auctionId: request.auctionId,
            note: "already-drawn",
            ticket: ticketOf(raffle, winning),
          }
        : {
            kind: "raffle-winner-outcome",
            auctionId: request.auctionId,
            note: "not-awaiting",
          },
    );
  }

  async function assign(
    request: Extract<RaffleWinnerRequest, { intent: "assign-raffle-winner" }>,
  ): Promise<ExecuteResult> {
    const answer = await consoles.assignRaffleWinner(
      request.identity,
      {
        auctionId: request.auctionId,
        ticket: request.ticket,
        opId: request.opId,
      },
      rpcMeta(request),
    );
    const { auctionId } = request;
    switch (answer.kind) {
      // Повтор того же ключа Auction отвечает розыгрышем как есть: исход
      // называет билет из ответа, а не из кнопки.
      case "ok": {
        const winning = answer.raffle.reveal?.winningTicket ?? request.ticket;
        return {
          kind: "raffle-winner-outcome",
          auctionId,
          note: "assigned",
          ticket: ticketOf(answer.raffle, winning),
        };
      }
      // Итог уже другой: имя выигравшего билета — из чтения розыгрыша, а
      // его отказ оставляет один номер.
      case "already-drawn": {
        const read = await consoles.consoleRaffle(
          request.identity,
          auctionId,
          rpcMeta(request),
        );
        return {
          kind: "raffle-winner-outcome",
          auctionId,
          note: "already-drawn",
          ticket: ticketOf(
            read.kind === "ok" ? read.raffle : undefined,
            answer.winningTicket,
          ),
        };
      }
      case "ticket-not-in-pool":
        return {
          kind: "raffle-winner-outcome",
          auctionId,
          note: "not-in-pool",
          tickets: answer.tickets,
        };
      case "not-awaiting-winner":
        return {
          kind: "raffle-winner-outcome",
          auctionId,
          note: "not-awaiting",
        };
      case "raffle-not-found":
        return { kind: "raffle-winner-outcome", auctionId, note: "no-raffle" };
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

  return async (request: RaffleWinnerRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-raffle-winner": {
        const found = await awaiting(request);
        return found.kind === "refused"
          ? found.result
          : {
              kind: "raffle-winner",
              auctionId: request.auctionId,
              raffle: found.raffle,
              page: request.page,
            };
      }
      case "ask-raffle-winner": {
        const found = await awaiting(request);
        return found.kind === "refused"
          ? found.result
          : {
              kind: "raffle-winner-ask",
              auctionId: request.auctionId,
              tickets: found.raffle.tickets.length,
            };
      }
      // Ответ разбирается по пулу, прочитанному заново: число билетов в
      // кнопку вопроса не кладётся, и рестарт его не теряет.
      case "pick-raffle-winner": {
        const found = await awaiting(request);
        if (found.kind === "refused") return found.result;
        const tickets = found.raffle.tickets.length;
        const parsed = parseWinnerTicket(request.value, tickets);
        return parsed.kind === "rejected"
          ? {
              kind: "raffle-winner-ask",
              auctionId: request.auctionId,
              tickets,
              error: parsed.error,
            }
          : {
              kind: "raffle-winner-confirm",
              auctionId: request.auctionId,
              ticket: ticketOf(found.raffle, parsed.ticket),
            };
      }
      // Подтверждение по номеру из кнопки — «Повторить» после сбоя на «Да»:
      // ответ на команду мог потеряться, и розыгрыш читается заново.
      case "prepare-raffle-winner": {
        const found = await awaiting(request);
        if (found.kind === "refused") return found.result;
        const tickets = found.raffle.tickets.length;
        return request.ticket >= 1 && request.ticket <= tickets
          ? {
              kind: "raffle-winner-confirm",
              auctionId: request.auctionId,
              ticket: ticketOf(found.raffle, request.ticket),
            }
          : {
              kind: "raffle-winner-outcome",
              auctionId: request.auctionId,
              note: "not-in-pool",
              tickets,
            };
      }
      case "assign-raffle-winner":
        return assign(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
