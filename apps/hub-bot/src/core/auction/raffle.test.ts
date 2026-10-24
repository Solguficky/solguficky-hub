import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  CancelRaffleRegistrationResponseSchema,
  RaffleSchema,
  RaffleStatus,
  RegisterForRaffleResponseSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import {
  cancellationOutcomeOf,
  raffleOf,
  registrationOutcomeOf,
} from "./raffle.js";

const AUCTION_ID = "daef05c7-cd68-5048-b03d-cb4860e8dc73";

describe("raffle answers", () => {
  it("reads an open raffle with its commitment and round", () => {
    expect(
      raffleOf(
        create(RaffleSchema, {
          auctionId: AUCTION_ID,
          status: RaffleStatus.OPEN,
          closesAt: "2026-10-29T18:00:00Z",
          commitment: "ab".repeat(32),
          beaconRound: 12_345_678n,
          registered: true,
        }),
      ),
    ).toEqual({
      auctionId: AUCTION_ID,
      status: "open",
      closesAt: "2026-10-29T18:00:00Z",
      commitment: "ab".repeat(32),
      beaconRound: 12_345_678,
      registered: true,
      tickets: [],
    });
  });

  it("reads the raffle prize and drops a blank one", () => {
    const withPrize = (rafflePrize: string) =>
      raffleOf(
        create(RaffleSchema, {
          auctionId: AUCTION_ID,
          status: RaffleStatus.OPEN,
          closesAt: "2026-10-29T18:00:00Z",
          registered: false,
          rafflePrize,
        }),
      );
    expect(withPrize("кружка")).toMatchObject({ prize: "кружка" });
    // Пустая строка — тот же розыгрыш без приза (PER-649).
    expect(withPrize("")).not.toHaveProperty("prize");
  });

  it("reads a drawn raffle with an erased name and the reveal", () => {
    expect(
      raffleOf(
        create(RaffleSchema, {
          auctionId: AUCTION_ID,
          status: RaffleStatus.DRAWN,
          closesAt: "2026-10-29T18:00:00Z",
          drawnAt: "2026-10-29T22:30:00Z",
          commitment: "ab".repeat(32),
          beaconRound: 7n,
          tickets: [{ number: 1, displayName: "@owl" }, { number: 2 }],
          myTicket: 2,
          reveal: {
            seed: "cd".repeat(32),
            randomness: "ef".repeat(32),
            value: "12".repeat(32),
            winningTicket: 1,
          },
        }),
      ),
    ).toMatchObject({
      status: "drawn",
      drawnAt: "2026-10-29T22:30:00Z",
      tickets: [{ number: 1, displayName: "@owl" }, { number: 2 }],
      myTicket: 2,
      reveal: { seed: "cd".repeat(32), winningTicket: 1 },
    });
  });

  // Момент жеребьёвки есть только у проведённой (PER-641): ответ без него —
  // не пустая строка, а отсутствующее поле.
  it("drops the draw moment of a drawn raffle that does not carry one", () => {
    const raffle = raffleOf(
      create(RaffleSchema, {
        auctionId: AUCTION_ID,
        status: RaffleStatus.DRAWN,
        closesAt: "2026-10-29T18:00:00Z",
        tickets: [{ number: 1 }],
      }),
    );
    expect(raffle).not.toHaveProperty("drawnAt");
    expect(raffle).toMatchObject({
      status: "drawn",
      closesAt: "2026-10-29T18:00:00Z",
    });
  });

  // Непроведённый розыгрыш несёт только момент: ни отпечатка, ни раунда.
  it("drops the empty commitment and round of a raffle not held", () => {
    const raffle = raffleOf(
      create(RaffleSchema, {
        auctionId: AUCTION_ID,
        status: RaffleStatus.NOT_HELD,
        closesAt: "2026-10-29T18:00:00Z",
      }),
    );
    expect(raffle).not.toHaveProperty("commitment");
    expect(raffle).not.toHaveProperty("beaconRound");
    expect(raffle.status).toBe("not-held");
  });

  // Аукцион отменили до жеребьёвки (PER-698): розыгрыш — свой статус, а не
  // дефект соседа.
  it("reads a raffle cancelled with its auction", () => {
    const raffle = raffleOf(
      create(RaffleSchema, {
        auctionId: AUCTION_ID,
        status: RaffleStatus.CANCELLED,
        closesAt: "2026-10-29T18:00:00Z",
        commitment: "ab".repeat(32),
        beaconRound: 12_345_678n,
      }),
    );
    expect(raffle).toMatchObject({
      status: "cancelled",
      commitment: "ab".repeat(32),
      beaconRound: 12_345_678,
    });
  });

  // Статус, которого бот ещё не знает, отменой не считается: перевод бросает,
  // и человек видит кадр сбоя.
  it("treats a status from a future contract as a defect of the neighbour", () => {
    expect(() =>
      raffleOf(
        create(RaffleSchema, {
          auctionId: AUCTION_ID,
          status: (RaffleStatus.CANCELLED + 1) as RaffleStatus,
        }),
      ),
    ).toThrow(/unknown status: 8/);
  });

  it("treats an unspecified status as a defect of the neighbour", () => {
    expect(() =>
      raffleOf(create(RaffleSchema, { auctionId: AUCTION_ID })),
    ).toThrow(/unknown status/);
  });

  it("names every registration and cancellation refusal", () => {
    const registration = (
      reason: "raffleNotFound" | "registrationClosed" | "displayNameNotChosen",
    ) =>
      registrationOutcomeOf(
        create(RegisterForRaffleResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: reason, value: {} } },
          },
        }),
      );
    expect(registration("raffleNotFound")).toEqual({
      kind: "refused",
      refusal: "raffle-not-found",
    });
    expect(registration("registrationClosed")).toEqual({
      kind: "refused",
      refusal: "registration-closed",
    });
    expect(registration("displayNameNotChosen")).toEqual({
      kind: "refused",
      refusal: "display-name-not-chosen",
    });
    expect(
      cancellationOutcomeOf(
        create(CancelRaffleRegistrationResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "registrationClosed", value: {} } },
          },
        }),
      ),
    ).toEqual({ kind: "refused", refusal: "registration-closed" });
    expect(() =>
      registrationOutcomeOf(create(RegisterForRaffleResponseSchema, {})),
    ).toThrow(/without an outcome/);
  });
});
