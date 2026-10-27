import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AuctionState_CancelledSchema,
  AuctionState_DraftSchema,
  AuctionState_FinalSchema,
  AuctionState_LineupFrozenSchema,
  AuctionState_PrebiddingSchema,
} from "../../../gen/auction/v1/auction_events_pb.js";
import {
  AuctionConfigSchema,
  AuctionStepWindowSchema,
  OnlinePhaseSchema,
} from "../../../gen/auction/v1/auction_pb.js";
import { AuctionSnapshotSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { auctionSummaryViewOf } from "./auction.js";

const AUCTION_ID = "daef05c7-cd68-5048-b03d-cb4860e8dc73";

// Снимок аукциона для его корня (PER-605): стадия, сроки онлайн-торгов и финал.
describe("auction snapshot for the root", () => {
  it("reads the stage, the online phase and the final of a running auction", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          config: create(AuctionConfigSchema, {
            onlinePhase: create(OnlinePhaseSchema, {
              opensAt: "2026-10-26T09:00:00Z",
              closesAt: "2026-10-29T18:00:00Z",
            }),
            finalBlocks: 1,
          }),
          status: {
            case: "prebidding",
            value: create(AuctionState_PrebiddingSchema, {}),
          },
        }),
      ),
    ).toEqual({
      auctionId: AUCTION_ID,
      stage: "prebidding",
      opensAt: "2026-10-26T09:00:00Z",
      closesAt: "2026-10-29T18:00:00Z",
      final: true,
    });
  });

  it("reads a draft without config as a stage without dates", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toEqual({ auctionId: AUCTION_ID, stage: "draft", final: false });
  });

  // Программа недели (PER-724): окна конфигурации и запущенные одним списком
  // по началу, ориентировочное время финала — как есть.
  it("reads the windows of the week and the estimated final for the programme", () => {
    const stepWindow = (from: string, until: string, lotIds: string[]) =>
      create(AuctionStepWindowSchema, { from, until, lotIds });
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          finalAt: "2026-10-31T16:00:00Z",
          config: create(AuctionConfigSchema, {
            finalBlocks: 1,
            stepWindows: [
              stepWindow("2026-10-28T15:00:00Z", "2026-10-28T17:00:00Z", [
                "lot-1",
              ]),
            ],
          }),
          launchedStepWindows: [
            stepWindow("2026-10-27T15:00:00Z", "2026-10-27T16:00:00Z", [
              "lot-2",
              "lot-3",
            ]),
          ],
          status: {
            case: "prebidding",
            value: create(AuctionState_PrebiddingSchema, {}),
          },
        }),
      ),
    ).toMatchObject({
      finalAt: "2026-10-31T16:00:00Z",
      stepWindows: [
        {
          from: "2026-10-27T15:00:00Z",
          until: "2026-10-27T16:00:00Z",
          lotIds: ["lot-2", "lot-3"],
        },
        {
          from: "2026-10-28T15:00:00Z",
          until: "2026-10-28T17:00:00Z",
          lotIds: ["lot-1"],
        },
      ],
    });
  });

  // Программа — подсказка: кривой момент выпадает из неё, а не роняет корень.
  it("drops a window or a final time it cannot read instead of throwing", () => {
    const view = auctionSummaryViewOf(
      create(AuctionSnapshotSchema, {
        id: AUCTION_ID,
        finalAt: "soon",
        launchedStepWindows: [
          create(AuctionStepWindowSchema, {
            from: "2026-10-27",
            until: "2026-10-27T16:00:00Z",
          }),
        ],
        status: {
          case: "prebidding",
          value: create(AuctionState_PrebiddingSchema, {}),
        },
      }),
    );
    expect(view).not.toHaveProperty("finalAt");
    expect(view).not.toHaveProperty("stepWindows");
  });

  // Видимость (PER-673): признак есть только у скрытого и только `true`.
  it("carries the hidden mark of an auction hidden from participants", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          hidden: true,
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toEqual({
      auctionId: AUCTION_ID,
      stage: "draft",
      final: false,
      hidden: true,
    });
  });

  // Отменённый аукцион — своя конечная стадия, а не завершённый (PER-606).
  it("translates a cancelled auction to its own stage", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          status: {
            case: "cancelled",
            value: create(AuctionState_CancelledSchema, {}),
          },
        }),
      ),
    ).toEqual({ auctionId: AUCTION_ID, stage: "cancelled", final: false });
  });

  // Дефект соседа — отказ перевода, а не корень с выдуманной стадией.
  it("throws on a snapshot without a status, an id or an instant it cannot read", () => {
    expect(() =>
      auctionSummaryViewOf(create(AuctionSnapshotSchema, { id: AUCTION_ID })),
    ).toThrow("auction snapshot without status");
    expect(() =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: "not-a-uuid",
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toThrow("auction id is not a canonical UUID");
    expect(() =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          config: create(AuctionConfigSchema, {
            onlinePhase: create(OnlinePhaseSchema, { opensAt: "soon" }),
          }),
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toThrow("auction online phase start is not an instant");
  });

  // Момент Auction обещает в RFC 3339 (PER-688): мягкий `Date.parse` взял бы
  // и дату без времени, и дату словами, и выдуманный срок попал бы в текст.
  describe("instants of the online phase", () => {
    const withPhase = (opensAt: string, closesAt: string) =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          config: create(AuctionConfigSchema, {
            onlinePhase: create(OnlinePhaseSchema, { opensAt, closesAt }),
          }),
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      );

    it.each(["2026-10-21", "Oct 21, 2026"])("refuses %s", (instant) => {
      expect(() => withPhase(instant, "2026-10-29T18:00:00Z")).toThrow(
        "auction online phase start is not an instant",
      );
      expect(() => withPhase("2026-10-26T09:00:00Z", instant)).toThrow(
        "auction online phase end is not an instant",
      );
    });

    it.each(["2026-10-21T21:00:00Z", "2026-10-21T21:00:00.123456Z"])(
      "accepts %s",
      (instant) => {
        expect(withPhase(instant, instant)).toMatchObject({
          opensAt: instant,
          closesAt: instant,
        });
      },
    );
  });

  // Состав финала (PER-639): лента в финале ставит лоты в порядке зала и
  // выделяет тот, что торгует ведущий.
  it("reads the lineup of a frozen lineup and of a running final", () => {
    const LOT_A = "01929b7e-5c1d-7a3f-8e4b-00000000000a";
    const LOT_B = "01929b7e-5c1d-7a3f-8e4b-00000000000b";
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          status: {
            case: "lineupFrozen",
            value: create(AuctionState_LineupFrozenSchema, {
              order: [LOT_A, LOT_B],
            }),
          },
        }),
      ),
    ).toEqual({
      auctionId: AUCTION_ID,
      stage: "lineup-frozen",
      final: false,
      lineup: { order: [LOT_A, LOT_B] },
    });
    const inFinal = (activeLotId?: string) =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          status: {
            case: "inFinal",
            value: create(AuctionState_FinalSchema, {
              order: [LOT_A, LOT_B],
              ...(activeLotId === undefined ? {} : { activeLotId }),
            }),
          },
        }),
      ).lineup;
    expect(inFinal(LOT_B)).toEqual({
      order: [LOT_A, LOT_B],
      activeLotId: LOT_B,
    });
    expect(inFinal()).toEqual({ order: [LOT_A, LOT_B] });
    // Кривой состав сводку не роняет: её читают ещё список аукционов и
    // корень, и лента тогда показывает себя как вне финала.
    expect(inFinal("")).toBeUndefined();
  });
});
