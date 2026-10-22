import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../../../gen/auction/v1/auction_pb.js";
import {
  ChooseDisplayNameResponseSchema,
  DisplayNameKind,
  GetDisplayNamesResponseSchema,
  type PlaceBidRefusal,
  PlaceBidResponseSchema,
  SetProxyLimitResponseSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import {
  bidOutcomeOf,
  displayNameOutcomeOf,
  limitOutcomeOf,
  ownDisplayNameOf,
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
    expect(
      refusedBid({
        case: "bidAboveMaximum",
        value: { maximum: rub(25500n) },
      } as PlaceBidRefusal["reason"]),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "bid-above-maximum",
        next: { minorUnits: 510_000, currency: "RUB" },
      },
    });
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

  // Бот ставит только от имени смотрящего: отказ ставки зала — дефект соседа.
  it("throws on a floor bid refusal reason", () => {
    for (const reason of [
      { case: "notMeetupAdministrator", value: {} },
      { case: "meetupNotFound", value: {} },
      { case: "participantCannotBid", value: {} },
    ] as PlaceBidRefusal["reason"][]) {
      expect(() => refusedBid(reason)).toThrow(/floor bid refusal/);
    }
  });

  it("reads an accepted bid and a refused limit", () => {
    expect(
      bidOutcomeOf(
        create(PlaceBidResponseSchema, {
          outcome: {
            case: "accepted",
            value: { bidId: "b-1", lotVersion: 7n },
          },
        }),
      ),
    ).toEqual({ kind: "accepted", lotVersion: 7 });
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

  // Снятый с лота участник (ADR-072) получает один отказ на ставку и на лимит.
  it("reads a removal from the lot on a bid and on a limit", () => {
    expect(
      refusedBid({
        case: "participantRemovedFromLot",
        value: {},
      } as PlaceBidRefusal["reason"]),
    ).toEqual({ kind: "refused", refusal: { kind: "removed-from-lot" } });
    expect(
      limitOutcomeOf(
        create(SetProxyLimitResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "participantRemovedFromLot", value: {} } },
          },
        }),
      ),
    ).toEqual({ kind: "refused", refusal: { kind: "removed-from-lot" } });
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
});

// Своё имя (PER-595): заглушка — имя не выбрано, иначе текст и заморозка.
describe("own display name", () => {
  const me = "01926f3c-8b7a-7cde-8f00-00000000000a";
  const answer = (kind: DisplayNameKind, frozen = false) =>
    create(GetDisplayNamesResponseSchema, {
      names: { [me]: { text: "Сова*", kind, frozen } },
    });

  it("reads a placeholder as no chosen name", () => {
    expect(
      ownDisplayNameOf(answer(DisplayNameKind.PLACEHOLDER), me),
    ).toBeUndefined();
  });

  it("carries the text and the freeze of a chosen name", () => {
    expect(ownDisplayNameOf(answer(DisplayNameKind.ALIAS, true), me)).toEqual({
      text: "Сова*",
      frozen: true,
    });
  });

  it("throws on an answer without the requested participant", () => {
    expect(() =>
      ownDisplayNameOf(create(GetDisplayNamesResponseSchema, {}), me),
    ).toThrow();
  });
});
