import { describe, expect, it } from "vitest";
import { launchLotLimit } from "../application/types.js";
import { decodeLaunchDraft, encodeLaunchDraft } from "./launch-draft.js";

// Черновик запуска окна едет в кнопке пульта (PER-615): состояния у пульта
// нет, а лот в 64 байта не помещается. Кодировка обязана переживать кнопку
// без потерь — иначе запустится не то окно.

describe("launch draft", () => {
  it("keeps the window and the lots through the button", () => {
    const draft = {
      from: "2026-10-20T15:00:00Z",
      until: "2026-10-20T18:00:00Z",
      step: { minorUnits: 5_000, currency: "RUB" },
      lots: [0, 3, launchLotLimit - 1],
    };

    const payload = encodeLaunchDraft(draft);

    expect(payload.length).toBeLessThanOrEqual(27);
    expect(decodeLaunchDraft(payload)).toEqual(draft);
  });

  it("keeps a window that starts at the moment of the command", () => {
    const draft = {
      until: "2026-10-20T18:00:00Z",
      step: { minorUnits: 500, currency: "RUB" },
      lots: [1, 2],
    };

    const decoded = decodeLaunchDraft(encodeLaunchDraft(draft));

    expect(decoded).toEqual(draft);
    expect(decoded?.from).toBeUndefined();
  });

  it("keeps a big step", () => {
    const draft = {
      from: "2026-10-20T15:00:00Z",
      until: "2026-10-20T18:00:00Z",
      step: { minorUnits: 9_999_999 * 100, currency: "RUB" },
      lots: [],
    };

    expect(decodeLaunchDraft(encodeLaunchDraft(draft))).toEqual(draft);
  });

  it("refuses a broken button", () => {
    expect(decodeLaunchDraft("")).toBeUndefined();
    expect(decodeLaunchDraft("n00000broken")).toBeUndefined();
    expect(decodeLaunchDraft("x0000000000000000000000A")).toBeUndefined();
    // Поле с посторонним символом — битая кнопка, а не значение по началу.
    expect(decodeLaunchDraft("n0000000000000!AAAAAAAAAAAAAAA")).toBeUndefined();
    expect(decodeLaunchDraft("n0000000000z0a9qAAAAAAA!AA")).toBeUndefined();
  });
});
