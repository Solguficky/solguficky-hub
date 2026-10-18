import { describe, expect, it } from "vitest";
import type {
  AuctionBlock,
  AuctionButton,
} from "../../../../auction-ui/index.js";
import {
  predictionAnswerRefusedScreen,
  predictionLotsScreen,
  predictionNameChoiceScreen,
  predictionNumberQuestionScreen,
  predictionScreen,
} from "./auction-predictions.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b4d";
const today = { year: 2026, month: 10, day: 7 };
const plain = (text: string) => text.replace(/[  ]/g, " ");

const prediction = (
  overrides: Partial<Extract<AuctionBlock, { kind: "prediction" }>> = {},
): Extract<AuctionBlock, { kind: "prediction" }> => ({
  kind: "prediction",
  auctionId: AUCTION_ID,
  round: "catalog",
  feedPage: 2,
  status: "open",
  answers: [
    {
      nomination: "catalog-most-expensive-lot",
      answer: { kind: "lot", lotId: LOT_ID },
    },
    {
      nomination: "catalog-total-sales",
      answer: { kind: "number", value: 1_234_567 },
    },
  ],
  lotNames: { [LOT_ID]: "Кружка" },
  ...(overrides.round === "final" ? {} : { opensAt: "2026-10-26T16:00:00Z" }),
  ...overrides,
});

const rows = (...buttons: AuctionButton[][]): AuctionButton[][] => buttons;

describe("prediction screens in the hub shell", () => {
  it("shows only the viewer's answers and the catalog close condition", () => {
    const shown = predictionScreen(
      prediction(),
      rows(
        [
          {
            action: "prediction.edit",
            callbackData: "v1:auc:pe:AZKbflwdej-OSy1snwobPA:c:1:2",
          },
        ],
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:f:2",
          },
        ],
        [{ action: "prediction.back", callbackData: "back" }],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.id).toBe("predictions");
    expect(shown.text).toContain("закроются при открытии онлайн-торгов");
    expect(shown.text).toContain("Кружка");
    expect(plain(shown.text)).toContain("12 345,67 ₽");
    expect(shown.text).not.toContain("чужой прогноз");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Изменить 1.1", "Раунд 2 · Финал", "‹ Лоты"]);
  });

  it("marks a closed round as fixed and removes nomination actions", () => {
    const closed = prediction({
      round: "final",
      status: "closed",
      notice: "round-closed",
    });
    const shown = predictionScreen(
      closed,
      rows(
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:c:2",
          },
        ],
        [{ action: "prediction.back", callbackData: "back" }],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.text).toContain("Прогноз зафиксирован");
    expect(shown.text).toContain("Раунд закрыт");
    expect(shown.text).toContain("Новый ответ не принят");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Раунд 1 · Каталог", "‹ Лоты"]);
  });

  it("does not claim an empty forecast was fixed", () => {
    const shown = predictionScreen(
      prediction({ round: "final", status: "closed", answers: [] }),
      rows(
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:c:2",
          },
        ],
        [{ action: "prediction.back", callbackData: "back" }],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.text).toContain("Раунд закрыт. Ответов нет.");
    expect(shown.text).not.toContain("Прогноз зафиксирован");
  });

  it("marks a lot answer that no longer belongs to an open round", () => {
    const shown = predictionScreen(
      prediction({ staleNominations: ["catalog-most-expensive-lot"] }),
      rows(
        [
          {
            action: "prediction.edit",
            callbackData: "v1:auc:pe:AZKbflwdej-OSy1snwobPA:c:1:2",
          },
        ],
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:f:2",
          },
        ],
        [
          {
            action: "prediction.back",
            callbackData: "v1:auc:feed:AZKbflwdej-OSy1snwobPA:2",
          },
        ],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.text).toContain("Кружка");
    expect(shown.text).toContain(
      "лот больше не входит в раунд; ответ не засчитается",
    );
  });

  it("explains an unanswered save without claiming whether it was accepted", () => {
    const shown = predictionScreen(
      prediction({ notice: "unanswered" }),
      rows(
        [
          {
            action: "prediction.edit",
            callbackData: "v1:auc:pe:AZKbflwdej-OSy1snwobPA:c:1:2",
          },
        ],
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:f:2",
          },
        ],
        [
          {
            action: "prediction.back",
            callbackData: "v1:auc:feed:AZKbflwdej-OSy1snwobPA:2",
          },
        ],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.text).toContain("Ответ мог сохраниться");
  });

  it("explains when a stale lot answer was removed during a successful save", () => {
    const shown = predictionScreen(
      prediction({ notice: "stale-answer-removed" }),
      rows(
        [
          {
            action: "prediction.edit",
            callbackData: "v1:auc:pe:AZKbflwdej-OSy1snwobPA:c:1:2",
          },
        ],
        [
          {
            action: "prediction.switch-round",
            callbackData: "v1:auc:pr:AZKbflwdej-OSy1snwobPA:f:2",
          },
        ],
        [
          {
            action: "prediction.back",
            callbackData: "v1:auc:feed:AZKbflwdej-OSy1snwobPA:2",
          },
        ],
      ),
      { timeZone: "Europe/Moscow", today },
    );

    expect(shown.text).toContain("Ответ на снятый лот удалён");
  });

  it("renders the final-round lot picker and its clear action", () => {
    const shown = predictionLotsScreen(
      {
        kind: "prediction-lots",
        auctionId: AUCTION_ID,
        round: "final",
        nomination: "final-most-expensive-lot",
        feedPage: 2,
        page: 0,
        pageCount: 1,
        lots: [
          {
            lotId: LOT_ID,
            title: "Кружка <с совой>",
            status: {
              kind: "held",
              currentPrice: { minorUnits: 90_000, currency: "RUB" },
            },
          },
        ],
        currentLotId: LOT_ID,
        currentTitle: "Кружка <с совой>",
      },
      rows(
        [
          {
            action: "prediction.select-lot",
            lotId: LOT_ID,
            callbackData: "select",
          },
        ],
        [{ action: "prediction.clear", callbackData: "clear" }],
        [{ action: "prediction.back", callbackData: "back" }],
      ),
    );

    expect(shown.text).toContain("2.1 · Какой лот финала уйдёт дороже всех?");
    expect(shown.text).toContain("Сейчас выбрано: Кружка &lt;с совой&gt;");
    expect(plain(shown.text)).toContain("Кружка &lt;с совой&gt; — 900 ₽");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => plain(button.text)),
    ).toEqual(["Кружка <с совой> · 900 ₽", "Очистить", "‹ Прогнозы"]);
  });

  it("shows the current number in the reply question and lets the user clear it", () => {
    const shown = predictionNumberQuestionScreen(
      {
        kind: "prediction-number-question",
        auctionId: AUCTION_ID,
        round: "catalog",
        nomination: "catalog-total-sales",
        feedPage: 2,
        currentValue: 1_234_567,
      },
      rows(
        [{ action: "prediction.clear", callbackData: "clear" }],
        [{ action: "question.cancel", callbackData: "cancel" }],
      ),
    );

    expect(plain(shown.text)).toContain("Сейчас указано: 12 345,67 ₽.");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Очистить", "Отмена"]);
  });

  it("uses the shared name-choice screen and returns to predictions", () => {
    const shown = predictionNameChoiceScreen(
      {
        kind: "prediction-name-choice",
        auctionId: AUCTION_ID,
        round: "final",
        feedPage: 8,
        username: "owl_fan",
      },
      rows(
        [{ action: "name.username", callbackData: "username" }],
        [{ action: "name.alias", callbackData: "alias" }],
        [{ action: "prediction.back", callbackData: "return" }],
      ),
    );

    expect(shown.id).toBe("prediction-name-choice");
    expect(shown.text).toContain("Чужие прогнозы не раскрываются");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Ник @owl_fan", "Взять псевдоним", "‹ Прогнозы"]);
    const backButton = shown.keyboard.inline_keyboard.at(-1)?.[0];
    expect(
      backButton !== undefined && "callback_data" in backButton
        ? backButton.callback_data
        : undefined,
    ).toBe("return");
  });

  it("returns from an invalid answer to the same nomination", () => {
    const shown = predictionAnswerRefusedScreen(
      {
        kind: "prediction-answer-refused",
        auctionId: AUCTION_ID,
        round: "final",
        nomination: "final-total-bids",
        feedPage: 8,
        refusal: "other-currency",
      },
      rows(
        [{ action: "answer.retry", callbackData: "retry" }],
        [{ action: "prediction.back", callbackData: "return" }],
      ),
    );

    expect(shown.text).toContain("Укажи сумму в рублях");
    expect(
      shown.keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["Ввести заново", "‹ Прогнозы"]);
    const retryButton = shown.keyboard.inline_keyboard[0]?.[0];
    expect(
      retryButton !== undefined && "callback_data" in retryButton
        ? retryButton.callback_data
        : undefined,
    ).toBe("retry");
  });
});
