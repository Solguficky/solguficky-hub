import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../gen/auction/v1/auction_pb.js";
import {
  ChooseDisplayNameResponseSchema,
  type PlaceBidRefusal,
  PlaceBidResponseSchema,
  SetProxyLimitResponseSchema,
} from "../gen/auction/v1/auction_service_pb.js";
import {
  bidOutcomeOf,
  createUuidV7,
  displayNameOutcomeOf,
  limitOutcomeOf,
  unansweredOn,
} from "./commands.js";

const rub = (rubles: bigint) =>
  create(MoneySchema, { minorUnits: rubles * 100n, currency: "RUB" });

const refusedBid = (reason: PlaceBidRefusal["reason"]) =>
  bidOutcomeOf(
    create(PlaceBidResponseSchema, {
      outcome: { case: "refused", value: { reason } },
    }),
  );

describe("participant command answers", () => {
  it("names the price of every priced bid refusal", () => {
    expect(
      refusedBid({
        case: "bidderIsLeader",
        value: { currentPrice: rub(1200n) },
      } as PlaceBidRefusal["reason"]),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "bidder-is-leader",
        currentPrice: { minorUnits: 120_000, currency: "RUB" },
      },
    });
    expect(
      refusedBid({
        case: "lotOnHold",
        value: { currentPrice: rub(900n) },
      } as PlaceBidRefusal["reason"]),
    ).toMatchObject({ refusal: { kind: "lot-on-hold" } });
    expect(
      refusedBid({
        case: "bidBelowMinimum",
        value: { minRequired: rub(1300n) },
      } as PlaceBidRefusal["reason"]),
    ).toMatchObject({ refusal: { kind: "bid-below-minimum" } });
  });

  // Отказ с ценой без цены — дефект соседа, а не отказ без суммы.
  it("refuses a priced refusal that carries no price", () => {
    expect(() =>
      bidOutcomeOf(
        create(PlaceBidResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "bidderIsLeader", value: {} } },
          },
        }),
      ),
    ).toThrow();
  });

  it("reads an accepted bid and a refused limit", () => {
    expect(
      bidOutcomeOf(
        create(PlaceBidResponseSchema, {
          outcome: { case: "accepted", value: { bidId: "b-1" } },
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      limitOutcomeOf(
        create(SetProxyLimitResponseSchema, {
          outcome: {
            case: "refused",
            value: {
              reason: {
                case: "proxyBelowCurrentPrice",
                value: { minLimit: rub(1200n) },
              },
            },
          },
        }),
      ),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "proxy-below-current-price",
        minLimit: { minorUnits: 120_000, currency: "RUB" },
      },
    });
  });

  it("reads a chosen name and its refusal", () => {
    expect(
      displayNameOutcomeOf(
        create(ChooseDisplayNameResponseSchema, {
          outcome: { case: "accepted", value: { text: "Сыч*" } },
        }),
      ),
    ).toEqual({ kind: "accepted", name: "Сыч*" });
    expect(
      displayNameOutcomeOf(
        create(ChooseDisplayNameResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "aliasTaken", value: {} } },
          },
        }),
      ),
    ).toEqual({ kind: "refused", refusal: "alias-taken" });
  });

  // Повторяемо только «ответа не было»: дедлайн или обрыв.
  it.each([Code.DeadlineExceeded, Code.Unavailable])(
    "turns code %i into unanswered",
    async (code) => {
      await expect(
        unansweredOn(() => Promise.reject(new ConnectError("x", code))),
      ).resolves.toEqual({ kind: "unanswered" });
    },
  );

  it.each([Code.PermissionDenied, Code.AlreadyExists, Code.InvalidArgument])(
    "lets code %i through as a failure",
    async (code) => {
      const failure = new ConnectError("x", code);
      await expect(unansweredOn(() => Promise.reject(failure))).rejects.toBe(
        failure,
      );
    },
  );

  it("makes a canonical UUIDv7 with the time in front", () => {
    expect(createUuidV7(0x0192_9b7e_5c1d)).toMatch(
      /^01929b7e-5c1d-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
