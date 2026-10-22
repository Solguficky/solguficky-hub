import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { LotSetCollectedSchema } from "../../../gen/notifications/v1/notifications_pb.js";
import {
  type LotSetNotice,
  lotSetNoticeOf,
  renderLotSetNotice,
} from "./lot-set-notice.js";

const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

const lotSetCollected = (lotCount = 3, setName = "Сервиз", anchor = lotId) =>
  create(LotSetCollectedSchema, { setName, lotCount, lotId: anchor });

describe("lotSetNoticeOf", () => {
  it("carries the set name, lot count and anchor lot", () => {
    expect(lotSetNoticeOf(lotSetCollected())).toEqual({
      kind: "lot-set-collected",
      setName: "Сервиз",
      lotCount: 3,
      lotId,
    });
  });

  it.each([
    ["a set with fewer than two lots", lotSetCollected(1)],
    [
      "a non-canonical lot id",
      lotSetCollected(3, "Сервиз", lotId.toUpperCase()),
    ],
  ])("rejects %s", (_, invalid) => {
    expect(lotSetNoticeOf(invalid)).toBeUndefined();
  });
});

describe("renderLotSetNotice", () => {
  const notice = (lotCount: number): LotSetNotice => ({
    kind: "lot-set-collected",
    setName: "Сервиз",
    lotCount,
    lotId,
  });

  it.each([
    [2, "лота"],
    [3, "лота"],
    [4, "лота"],
    [5, "лотов"],
    [11, "лотов"],
    [21, "лот"],
  ])("uses the correct Russian form for %i lots", (count, word) => {
    expect(renderLotSetNotice(notice(count)).text).toBe(
      `Ты собрал сет «Сервиз»: в нём ${count} ${word}.`,
    );
  });

  it("offers one button to the set screen anchor", () => {
    expect(renderLotSetNotice(notice(3))).toEqual({
      text: "Ты собрал сет «Сервиз»: в нём 3 лота.",
      button: { lotId, text: "К сету" },
    });
  });

  it("truncates long organizer names before composing the message", () => {
    const rendered = renderLotSetNotice({
      ...notice(3),
      setName: '"'.repeat(1_000),
    });

    expect(rendered.text.length).toBeLessThan(700);
    expect(rendered.text).toContain(`${'"'.repeat(599)}…`);
  });
});
