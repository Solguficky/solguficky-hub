import { describe, expect, it } from "vitest";
import {
  predictionNameChoiceText,
  predictionParagraphs,
} from "./auction-prediction.js";
import type { AuctionBlock } from "./auction-ui/index.js";

const catalogPrediction = {
  kind: "prediction",
  auctionId: "auction-1",
  round: "catalog",
  status: "open",
  answers: [],
  lotNames: {},
  closesAt: "2026-10-31T12:00:00Z",
} satisfies Extract<AuctionBlock, { kind: "prediction" }>;

describe("shared auction prediction copy", () => {
  it("names the common deadline of online trading as the end of the catalog round", () => {
    const paragraphs = predictionParagraphs(catalogPrediction, {
      moment: () => "31 октября, 12:00",
      money: () => "0 ₽",
    });

    expect(paragraphs[0]).toBe(
      "Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов — 31 октября, 12:00.",
    );
  });

  it("explains when a chosen name appears without exposing other predictions", () => {
    const text = predictionNameChoiceText("owl_fan");

    expect(text).toContain("рядом с твоими ставками");
    expect(text).toContain("если угадаешь, его покажут в итогах прогнозов");
    expect(text).toContain("Чужие прогнозы не раскрываются");
    expect(text).not.toContain("рядом с твоими ставками и прогнозами");
  });
});
