import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  LotConfigSchema,
  LotPhase,
  type Money,
  MoneySchema,
  StepPolicySchema,
  StepTierSchema,
  TieredStepsSchema,
  UnsoldReason,
  WithdrawnReason,
} from "../../../gen/auction/v1/auction_pb.js";
import {
  DisplayNameKind,
  DisplayNameSchema,
  LotSetMembershipSchema,
  LotSnapshotSchema,
  LotStepWindowSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import { lotViewOf } from "./snapshot.js";

const rub = (rubles: bigint): Money =>
  create(MoneySchema, { minorUnits: rubles * 100n, currency: "RUB" });

const base = { id: "lot-1", auctionId: "auc-1", version: 4n };

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
          phase: LotPhase.ONLINE,
        },
      },
      {
        kind: "trading",
        currentPrice: { minorUnits: 120_000, currency: "RUB" },
        leaderId: "p-1",
        deadline: "2026-10-10T18:00:00Z",
        phase: "online",
      },
    ],
    [
      {
        case: "trading",
        value: { currentPrice: rub(100n), phase: LotPhase.LIVE },
      },
      {
        kind: "trading",
        currentPrice: { minorUnits: 10_000, currency: "RUB" },
        phase: "live",
      },
    ],
    // Ask ведущего выше цены — следующая цена финала (PER-336).
    [
      {
        case: "trading",
        value: {
          currentPrice: rub(100n),
          ask: rub(150n),
          phase: LotPhase.LIVE,
        },
      },
      {
        kind: "trading",
        currentPrice: { minorUnits: 10_000, currency: "RUB" },
        phase: "live",
        ask: { minorUnits: 15_000, currency: "RUB" },
      },
    ],
    // Ask не выше цены уже ничего не объявляет.
    [
      {
        case: "trading",
        value: {
          currentPrice: rub(150n),
          ask: rub(150n),
          phase: LotPhase.LIVE,
        },
      },
      {
        kind: "trading",
        currentPrice: { minorUnits: 15_000, currency: "RUB" },
        phase: "live",
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
    const bare = create(LotSnapshotSchema, {
      ...base,
      status: { case: "draft", value: {} },
    });
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

    const tiered = create(LotSnapshotSchema, {
      id: "lot-1",
      auctionId: "auc-1",
      version: 1n,
      config: create(LotConfigSchema, {
        currency: "RUB",
        stepPolicy: create(StepPolicySchema, {
          policy: {
            case: "tiered",
            value: create(TieredStepsSchema, {
              tiers: [
                create(StepTierSchema, { lowerBound: rub(0n), step: rub(10n) }),
                create(StepTierSchema, {
                  lowerBound: rub(500n),
                  step: rub(25n),
                }),
              ],
            }),
          },
        }),
      }),
      status: { case: "unsold", value: UnsoldReason.NO_BIDS },
    });
    const view = lotViewOf(tiered);
    expect(view.fixedStep).toBeUndefined();
    expect(view.tiers).toEqual([
      {
        lowerBound: { minorUnits: 0, currency: "RUB" },
        step: { minorUnits: 1_000, currency: "RUB" },
      },
      {
        lowerBound: { minorUnits: 50_000, currency: "RUB" },
        step: { minorUnits: 2_500, currency: "RUB" },
      },
    ]);
  });

  // «Счастливые часы» (PER-505): обычный шаг и оба окна снимка доходят до
  // экранов как есть — какое окно показать, решает карточка.
  it("reads the regular step and the windows of reduced step", () => {
    const window = (from: string, until: string) =>
      create(LotStepWindowSchema, { from, until, step: rub(10n) });
    const view = lotViewOf(
      create(LotSnapshotSchema, {
        ...base,
        baseStep: rub(50n),
        activeWindow: window("2026-10-10T15:00:00Z", "2026-10-10T18:00:00Z"),
        nextWindow: window("2026-10-11T12:00:00Z", "2026-10-11T15:00:00Z"),
        status: {
          case: "trading",
          value: { currentPrice: rub(1200n), phase: LotPhase.ONLINE },
        },
      }),
    );
    const step = { minorUnits: 1_000, currency: "RUB" };
    expect(view.baseStep).toEqual({ minorUnits: 5_000, currency: "RUB" });
    expect(view.activeWindow).toEqual({
      from: "2026-10-10T15:00:00Z",
      until: "2026-10-10T18:00:00Z",
      step,
    });
    expect(view.nextWindow).toEqual({
      from: "2026-10-11T12:00:00Z",
      until: "2026-10-11T15:00:00Z",
      step,
    });
  });

  it("refuses a window without a step", () => {
    const snapshot = create(LotSnapshotSchema, {
      ...base,
      activeWindow: create(LotStepWindowSchema, {
        from: "2026-10-10T15:00:00Z",
        until: "2026-10-10T18:00:00Z",
      }),
      status: {
        case: "trading",
        value: { currentPrice: rub(1200n), phase: LotPhase.ONLINE },
      },
    });
    expect(() => lotViewOf(snapshot)).toThrow("without an amount");
  });

  // Сет лота (ADR-073, п. 7): название, состав по порядку организатора и
  // собравший по отображаемому имени. До итога сета имени нет.
  it("reads the set of the lot and the collector after the outcome", () => {
    const set = create(LotSetMembershipSchema, {
      lotSetId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
      name: "Лесные дары",
      lotIds: ["lot-1", "lot-2"],
    });
    const before = create(LotSnapshotSchema, {
      ...base,
      lotSet: set,
      status: { case: "unsold", value: UnsoldReason.NO_BIDS },
    });
    expect(lotViewOf(before).lotSet).toEqual({
      name: "Лесные дары",
      lotIds: ["lot-1", "lot-2"],
    });
    const after = create(LotSnapshotSchema, {
      ...base,
      lotSet: create(LotSetMembershipSchema, {
        lotSetId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
        name: "Лесные дары",
        lotIds: ["lot-1", "lot-2"],
        collectorId: "p-1",
        collectorName: create(DisplayNameSchema, {
          text: "@owl",
          kind: DisplayNameKind.TELEGRAM_USERNAME,
        }),
      }),
      status: { case: "unsold", value: UnsoldReason.NO_BIDS },
    });
    expect(lotViewOf(after).lotSet).toEqual({
      name: "Лесные дары",
      lotIds: ["lot-1", "lot-2"],
      collectorName: "@owl",
    });
  });

  it("refuses a snapshot without status", () => {
    expect(() => lotViewOf(create(LotSnapshotSchema, base))).toThrow(
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
        create(LotSnapshotSchema, {
          ...base,
          status: { case: "sold", value: { winnerId: "p", price: huge } },
        }),
      ),
    ).toThrow("safe integer");
  });
});
