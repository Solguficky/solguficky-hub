import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { LotSetCollectedSchema } from "../../../gen/notifications/v1/notifications_pb.js";
import {
  type LotSetNotice,
  lotSetNoticeOf,
  renderLotSetNotice,
} from "./lot-set-notice.js";

const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

const value = (lotCount = 3, setName = "Сервиз", anchor = lotId) =>
  create(LotSetCollectedSchema, { setName, lotCount, lotId: anchor });

describe("lotSetNoticeOf", () => {
  it("carries the set name, lot count and anchor lot", () => {
    expect(lotSetNoticeOf(value())).toEqual({
      kind: "lot-set-collected",
      setName: "Сервиз",
      lotCount: 3,
      lotId,
    });
  });

  it.each([
    ["an empty set name", value(3, "  ")],
    ["a set with fewer than two lots", value(1)],
    ["a non-integer lot count", value(2.5)],
    [
      "a lot id that is not UUIDv7",
      value(3, "Сервиз", "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b"),
    ],
    ["a non-canonical lot id", value(3, "Сервиз", lotId.toUpperCase())],
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
});
