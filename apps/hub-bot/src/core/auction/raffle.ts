import {
  type CancelRaffleRegistrationResponse,
  type Raffle,
  RaffleStatus,
  type RegisterForRaffleResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  RaffleCancellationRefusal,
  RaffleOutcome,
  RaffleRegistrationRefusal,
  RaffleStatusView,
  RaffleView,
} from "../../auction-ui/index.js";

// Розыгрыш среди участников (ADR-066) в словаре пакета. Перевод общий у
// обеих поверхностей. Значение вне контракта — `UNSPECIFIED`, незнакомый
// статус, ответ без исхода — дефект соседа: перевод бросает, а не показывает
// розыгрыш, которого нет.

const STATUSES: Readonly<Record<number, RaffleStatusView>> = {
  [RaffleStatus.OPEN]: "open",
  [RaffleStatus.CLOSING]: "closing",
  [RaffleStatus.AWAITING_BEACON]: "awaiting-beacon",
  [RaffleStatus.DRAWN]: "drawn",
  [RaffleStatus.NO_TICKETS]: "no-tickets",
  [RaffleStatus.NOT_HELD]: "not-held",
  [RaffleStatus.CANCELLED]: "cancelled",
};

export function raffleOf(raffle: Raffle): RaffleView {
  const status = STATUSES[raffle.status];
  if (status === undefined) {
    throw new Error(`raffle with an unknown status: ${raffle.status}`);
  }
  const { reveal } = raffle;
  return {
    auctionId: raffle.auctionId,
    status,
    closesAt: raffle.closesAt,
    ...(raffle.drawnAt === undefined ? {} : { drawnAt: raffle.drawnAt }),
    ...(raffle.commitment === "" ? {} : { commitment: raffle.commitment }),
    ...(raffle.beaconRound === 0n
      ? {}
      : { beaconRound: Number(raffle.beaconRound) }),
    registered: raffle.registered,
    tickets: raffle.tickets.map((ticket) => ({
      number: ticket.number,
      ...(ticket.displayName === undefined
        ? {}
        : { displayName: ticket.displayName }),
    })),
    ...(raffle.myTicket === undefined ? {} : { myTicket: raffle.myTicket }),
    // Пробельная строка призом не считается: строка «Приз:» без текста не
    // должна появляться даже на строке, записанной в обход пульта (PER-649).
    ...(raffle.rafflePrize === undefined || raffle.rafflePrize.trim() === ""
      ? {}
      : { prize: raffle.rafflePrize }),
    ...(reveal === undefined
      ? {}
      : {
          reveal: {
            seed: reveal.seed,
            ...(reveal.randomness === ""
              ? {}
              : { randomness: reveal.randomness }),
            ...(reveal.value === "" ? {} : { value: reveal.value }),
            ...(reveal.winningTicket === undefined
              ? {}
              : { winningTicket: reveal.winningTicket }),
          },
        }),
  };
}

export function registrationOutcomeOf(
  response: RegisterForRaffleResponse,
): RaffleOutcome<RaffleRegistrationRefusal> {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted", raffle: raffleOf(outcome.value) };
    case "refused": {
      const { reason } = outcome.value;
      switch (reason.case) {
        case "raffleNotFound":
          return { kind: "refused", refusal: "raffle-not-found" };
        case "registrationClosed":
          return { kind: "refused", refusal: "registration-closed" };
        case "displayNameNotChosen":
          return { kind: "refused", refusal: "display-name-not-chosen" };
        case undefined:
          throw new Error("raffle registration refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      throw new Error("raffle registration response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function cancellationOutcomeOf(
  response: CancelRaffleRegistrationResponse,
): RaffleOutcome<RaffleCancellationRefusal> {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted", raffle: raffleOf(outcome.value) };
    case "refused": {
      const { reason } = outcome.value;
      switch (reason.case) {
        case "raffleNotFound":
          return { kind: "refused", refusal: "raffle-not-found" };
        case "registrationClosed":
          return { kind: "refused", refusal: "registration-closed" };
        case undefined:
          throw new Error("raffle cancellation refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      throw new Error("raffle cancellation response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
