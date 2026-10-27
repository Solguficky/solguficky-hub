import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AuctionSnapshotSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { auctionSummaryOf } from "./snapshot.js";

describe("auctionSummaryOf", () => {
  const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
  const snapshot = (fields: Record<string, unknown>) =>
    create(AuctionSnapshotSchema, {
      id: auctionId,
      lotIds: ["lot-1", "lot-2"],
      status: { case: "prebidding", value: {} },
      ...fields,
    });

  it("reads the start of the online phase, the stage and the lot count", () => {
    expect(
      auctionSummaryOf(
        snapshot({
          config: { onlinePhase: { opensAt: "2026-10-10T16:00:00Z" } },
          status: { case: "onBreak", value: {} },
        }),
      ),
    ).toEqual({
      auctionId,
      stage: "on-break",
      opensAt: "2026-10-10T16:00:00Z",
      lotCount: 2,
      week: { stage: "on-break", opensAt: "2026-10-10T16:00:00Z" },
    });
    expect(auctionSummaryOf(snapshot({}))).not.toHaveProperty("opensAt");
  });

  // Строка состояния (PER-767) берёт неделю общим переводом сводки: конец
  // онлайн-фазы — и без финала, окна конфигурации и запущенные, розыгрыш.
  it("carries the week of the status line", () => {
    const window = {
      from: "2026-10-12T15:00:00Z",
      until: "2026-10-12T19:00:00Z",
      lotIds: ["lot-1"],
    };
    expect(
      auctionSummaryOf(
        snapshot({
          config: {
            onlinePhase: {
              opensAt: "2026-10-10T16:00:00Z",
              closesAt: "2026-10-17T21:00:00Z",
              raffleClosesAt: "2026-10-15T18:00:00Z",
            },
            stepWindows: [window],
          },
          launchedStepWindows: [{ ...window, from: "2026-10-11T15:00:00Z" }],
        }),
      ).week,
    ).toEqual({
      stage: "prebidding",
      opensAt: "2026-10-10T16:00:00Z",
      closesAt: "2026-10-17T21:00:00Z",
      stepWindows: [{ ...window, from: "2026-10-11T15:00:00Z" }, window],
      raffleClosesAt: "2026-10-15T18:00:00Z",
    });
  });

  // Кривой конец фазы у аукциона без финала строка списка не показывает: он
  // убирает строку состояния, а не список.
  it("drops the week when the shared translation refuses it", () => {
    const summary = auctionSummaryOf(
      snapshot({
        config: {
          finalBlocks: 0,
          onlinePhase: { opensAt: "2026-10-10T16:00:00Z", closesAt: "soon" },
        },
      }),
    );
    expect(summary).toMatchObject({ opensAt: "2026-10-10T16:00:00Z" });
    expect(summary).not.toHaveProperty("week");
  });

  // Общий дедлайн лотов — источник отсчёта до финала (PER-518).
  const timed = (finalBlocks: number, closesLots: boolean) => ({
    config: {
      finalBlocks,
      onlinePhase: {
        opensAt: "2026-10-10T16:00:00Z",
        closesAt: "2026-10-17T21:00:00Z",
        closesLots,
      },
    },
  });

  it("reads the common deadline of the lots of an auction with a final", () => {
    expect(auctionSummaryOf(snapshot(timed(1, true)))).toMatchObject({
      closesAt: "2026-10-17T21:00:00Z",
    });
  });

  // Фаза, которая кончается командой, дедлайна не несёт; `final_blocks = 0` —
  // финала нет; конец фазы без `closes_lots` дедлайном лотов не становится.
  it.each([
    [
      "a phase ended by a command",
      {
        config: {
          finalBlocks: 1,
          onlinePhase: { opensAt: "2026-10-10T16:00:00Z", closesLots: true },
        },
      },
    ],
    ["an auction without a final", timed(0, true)],
    ["a phase that does not close the lots", timed(1, false)],
  ])("has no deadline for %s", (_name, fields) => {
    expect(auctionSummaryOf(snapshot(fields))).not.toHaveProperty("closesAt");
  });

  it.each([
    ["a draft", { status: { case: "draft", value: {} } }],
    ["no status", { status: { case: undefined } }],
    ["a non-canonical id", { id: "DAEF05C7-CD68-5048-B03D-CB4860E8DC73" }],
    [
      "a broken online phase start",
      { config: { onlinePhase: { opensAt: "soon" } } },
    ],
    [
      "a broken common deadline",
      {
        config: {
          finalBlocks: 1,
          onlinePhase: {
            opensAt: "2026-10-10T16:00:00Z",
            closesAt: "later",
            closesLots: true,
          },
        },
      },
    ],
  ])("refuses %s", (_name, fields) => {
    expect(() => auctionSummaryOf(snapshot(fields))).toThrow();
  });

  // Момент Auction обещает в RFC 3339 (PER-688): мягкий `Date.parse` взял бы
  // и дату без времени, и дату словами, и выдуманный срок попал бы в текст.
  const withPhase = (opensAt: string, closesAt: string) =>
    snapshot({
      config: {
        finalBlocks: 1,
        onlinePhase: { opensAt, closesAt, closesLots: true },
      },
    });

  it.each(["2026-10-21", "Oct 21, 2026"])(
    "refuses the instant %s",
    (instant) => {
      expect(() =>
        auctionSummaryOf(withPhase(instant, "2026-10-17T21:00:00Z")),
      ).toThrow("auction online phase start is not an instant");
      expect(() =>
        auctionSummaryOf(withPhase("2026-10-10T16:00:00Z", instant)),
      ).toThrow("auction online phase end is not an instant");
    },
  );

  it.each(["2026-10-21T21:00:00Z", "2026-10-21T21:00:00.123456Z"])(
    "accepts the instant %s",
    (instant) => {
      expect(auctionSummaryOf(withPhase(instant, instant))).toMatchObject({
        opensAt: instant,
        closesAt: instant,
      });
    },
  );
});
