import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  LotConfigSchema,
  type Money,
  MoneySchema,
  StepPolicySchema,
  UnsoldReason,
  WithdrawnReason,
} from "../gen/auction/v1/auction_pb.js";
import {
  type LotSnapshot,
  LotSnapshotSchema,
} from "../gen/auction/v1/auction_service_pb.js";
import { lotViewOf } from "./snapshot.js";

const rub = (rubles: bigint): Money =>
  create(MoneySchema, { minorUnits: rubles * 100n, currency: "RUB" });

function snapshot(status: LotSnapshot["status"]): LotSnapshot {
  return create(LotSnapshotSchema, {
    id: "lot-1",
    auctionId: "auc-1",
    version: 4n,
    status,
  });
}

describe("lotViewOf", () => {
  it.each([
    [{ case: "draft", value: {} }, { kind: "draft" }],
    [
      { case: "scheduled", value: { startingPrice: rub(500n) } },
      {
        kind: "scheduled",
        startingPrice: { minorUnits: 50_000, currency: "RUB" },
      },
    ],
    [
      {
        case: "trading",
        value: {
          currentPrice: rub(1200n),
          leaderId: "p-1",
          deadline: "2026-10-10T18:00:00Z",
        },
      },
      {
        kind: "trading",
        currentPrice: { minorUnits: 120_000, currency: "RUB" },
        leaderId: "p-1",
        deadline: "2026-10-10T18:00:00Z",
      },
    ],
    [
      { case: "trading", value: { currentPrice: rub(100n) } },
      {
        kind: "trading",
        currentPrice: { minorUnits: 10_000, currency: "RUB" },
      },
    ],
    [
      { case: "held", value: { currentPrice: rub(700n), leaderId: "p-2" } },
      {
        kind: "held",
        currentPrice: { minorUnits: 70_000, currency: "RUB" },
        leaderId: "p-2",
      },
    ],
    [
      { case: "sold", value: { winnerId: "p-3", price: rub(3000n) } },
      {
        kind: "sold",
        winnerId: "p-3",
        price: { minorUnits: 300_000, currency: "RUB" },
      },
    ],
    [{ case: "unsold", value: UnsoldReason.NO_BIDS }, { kind: "unsold" }],
    [
      { case: "withdrawn", value: WithdrawnReason.BY_ORGANIZER },
      { kind: "withdrawn" },
    ],
  ])("maps status %o", (status, expected) => {
    const wire = create(LotSnapshotSchema, {
      id: "lot-1",
      auctionId: "auc-1",
      version: 4n,
      // biome-ignore lint/suspicious/noExplicitAny: таблица держит разные ветки oneof в одном столбце
      status: status as any,
    });
    expect(lotViewOf(wire).status).toEqual(expected);
  });

  it("keeps an absent card absent and carries the image version", () => {
    const bare = snapshot({ case: "draft", value: {} as never });
    expect(lotViewOf(bare)).not.toHaveProperty("card");
    const withCard = create(LotSnapshotSchema, {
      id: "lot-1",
      auctionId: "auc-1",
      version: 4n,
      card: { title: "Кружка", description: "", image: { version: "v1" } },
      status: { case: "draft", value: {} },
    });
    expect(lotViewOf(withCard).card).toEqual({
      title: "Кружка",
      description: "",
      image: { version: "v1" },
    });
  });

  it("reads the step only from a fixed policy", () => {
    const fixed = create(LotSnapshotSchema, {
      id: "lot-1",
      auctionId: "auc-1",
      version: 1n,
      config: create(LotConfigSchema, {
        currency: "RUB",
        stepPolicy: create(StepPolicySchema, {
          policy: { case: "fixed", value: rub(50n) },
        }),
      }),
      status: { case: "unsold", value: UnsoldReason.NO_BIDS },
    });
    expect(lotViewOf(fixed).fixedStep).toEqual({
      minorUnits: 5_000,
      currency: "RUB",
    });
  });

  it("refuses a snapshot without status", () => {
    expect(() => lotViewOf(snapshot({ case: undefined }))).toThrow(
      "without status",
    );
  });

  // Сумма за пределом 2^53 копеек — дефект соседа, а не цена лота.
  it("refuses an amount outside the safe integer range", () => {
    const huge = create(MoneySchema, {
      minorUnits: 2n ** 60n,
      currency: "RUB",
    });
    expect(() =>
      lotViewOf(
        snapshot({
          case: "sold",
          value: { winnerId: "p", price: huge },
        } as never),
      ),
    ).toThrow("safe integer");
  });
});
