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
      "Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов — 31 октября, 12:00. Итоги подведём в конце аукциона, после финала, по всему аукциону.",
    );
  });

  // PER-813: оба раунда, открытые и закрытые, говорят, когда будут итоги;
  // у раунда финала точного часа нет, ответы — до старта финала.
  it("says when the results come in every state of both rounds", () => {
    const textOf = (block: Partial<typeof catalogPrediction> & object) =>
      predictionParagraphs(
        { ...catalogPrediction, ...block } as Extract<
          AuctionBlock,
          { kind: "prediction" }
        >,
        { moment: () => "31 октября, 12:00", money: () => "0 ₽" },
      )[0];

    expect(textOf({ status: "closed" } as never)).toContain(
      "после финала, по всему аукциону",
    );
    const final = textOf({ round: "final", status: "open" } as never);
    expect(final).toContain("до старта финала, точного часа нет");
    expect(final).toContain("после финала");
    expect(textOf({ round: "final", status: "not-open" } as never)).toContain(
      "до старта финала",
    );
    expect(textOf({ round: "final", status: "closed" } as never)).toContain(
      "после финала",
    );
  });

  // PER-813: итоги во вкладке «Прогнозы» со своим ответом и понятной разницей.
  it("shows own answer next to the result with a plain difference", () => {
    const text = predictionParagraphs(
      {
        ...catalogPrediction,
        status: "closed",
        answers: [
          {
            nomination: "catalog-total-sales",
            answer: { kind: "number", value: 2_900_000 },
          },
          {
            nomination: "catalog-most-expensive-lot",
            answer: { kind: "lot", lotId: "lot-1" },
          },
        ],
        lotNames: { "lot-1": "Кружка" },
        results: {
          kind: "counted",
          nominations: [
            {
              nomination: "catalog-total-sales",
              value: { kind: "number", value: 3_000_000 },
              winnerNames: [],
              winnerCount: 0,
              mine: { kind: "missed", deviation: 100_000 },
            },
            {
              nomination: "catalog-most-expensive-lot",
              value: { kind: "lots", titles: ["Плакат"] },
              winnerNames: [],
              winnerCount: 0,
              mine: { kind: "missed" },
            },
          ],
        },
      },
      {
        moment: () => "",
        money: ({ minorUnits }) => `${minorUnits / 100} ₽`,
      },
    ).join("\n");

    expect(text).toContain(
      "Твой прогноз: 29000 ₽, итог: 30000 ₽, разница 1000 ₽; ты не угадал.",
    );
    expect(text).toContain("Твой лот: «Кружка», итог: «Плакат»; ты не угадал.");
    expect(text).not.toContain("Итоги подведём");
    expect(text).not.toContain("Отклонение");
  });

  // PER-813: ручной и отменённый исходы не противоречат тексту раунда, а ответы
  // участника остаются; вердикт даёт результат Auction.
  it("keeps the answers when the results are settled by hand and says so once", () => {
    const text = predictionParagraphs(
      {
        ...catalogPrediction,
        status: "closed",
        answers: [
          {
            nomination: "catalog-total-sales",
            answer: { kind: "number", value: 5 },
          },
        ],
        results: { kind: "by-hand" },
      } as never,
      { moment: () => "", money: () => "5 ₽" },
    ).join("\n");
    expect(text).toContain("5 ₽");
    expect(text).toContain("Итоги подведены вручную");
    expect(text).not.toContain("Итоги подведём");
  });

  it("says the auction was cancelled instead of promising the results", () => {
    const text = predictionParagraphs(
      {
        ...catalogPrediction,
        status: "closed",
        results: { kind: "cancelled" },
      } as never,
      { moment: () => "", money: () => "" },
    ).join("\n");
    expect(text).toContain("Аукцион отменён, итогов прогнозов нет.");
    expect(text).not.toContain("Итоги подведём");
  });

  it("does not call an answer lost when Auction returned no own result", () => {
    const text = predictionParagraphs(
      {
        ...catalogPrediction,
        status: "closed",
        answers: [
          {
            nomination: "catalog-total-sales",
            answer: { kind: "number", value: 5 },
          },
        ],
        results: {
          kind: "counted",
          nominations: [
            {
              nomination: "catalog-total-sales",
              value: { kind: "number", value: 7 },
              winnerNames: [],
              winnerCount: 0,
            },
          ],
        },
      } as never,
      { moment: () => "", money: () => "x" },
    ).join("\n");
    expect(text).not.toContain("ты не угадал");
    expect(text).not.toContain("не заполнял");
  });

  it("explains when a chosen name appears without exposing other predictions", () => {
    const text = predictionNameChoiceText("owl_fan");

    expect(text).toContain("рядом с твоими ставками");
    expect(text).toContain("если угадаешь, его покажут в итогах прогнозов");
    expect(text).toContain("Чужие прогнозы не раскрываются");
    expect(text).not.toContain("рядом с твоими ставками и прогнозами");
  });
});
