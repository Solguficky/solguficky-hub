import { describe, expect, it } from "vitest";
import { MAX_COMMAND_AMOUNT } from "../../callback-data.js";
import { parseAmount } from "./amount.js";

// Ввод суммы — недоверенная строка: любой ответ даёт значение, а не
// исключение (критерий приёмки PER-317).
describe("parseAmount", () => {
  it.each([
    ["1250", 125000],
    ["1 250", 125000],
    ["1 250", 125000],
    ["1250 ₽", 125000],
    ["1250р", 125000],
    ["1250 руб.", 125000],
    ["₽1250", 125000],
    ["1250,5", 125050],
    ["1250.05", 125005],
    ["  1300  ", 130000],
  ])("reads %j as %i kopecks", (text, minorUnits) => {
    expect(parseAmount(text, "RUB")).toEqual({ ok: true, minorUnits });
  });

  it.each([
    ["много", "not-a-number"],
    ["", "not-a-number"],
    ["12 50", "not-a-number"],
    ["1e3", "not-a-number"],
    ["$20", "other-currency"],
    ["20 USD", "other-currency"],
    ["20€", "other-currency"],
    ["20 евро", "other-currency"],
    ["0", "not-positive"],
    ["-5", "not-positive"],
    ["0,00", "not-positive"],
    ["10,505", "too-precise"],
    ["999999999999999999999", "too-large"],
    [String(MAX_COMMAND_AMOUNT / 100 + 1), "too-large"],
  ])("refuses %j with %s", (text, refusal) => {
    expect(parseAmount(text, "RUB")).toEqual({ ok: false, refusal });
  });

  it("accepts the ceiling of the button", () => {
    expect(parseAmount("604661,75", "RUB")).toEqual({
      ok: true,
      minorUnits: MAX_COMMAND_AMOUNT,
    });
  });

  it("refuses the ruble sign on a lot in another currency", () => {
    expect(parseAmount("20 ₽", "EUR")).toEqual({
      ok: false,
      refusal: "other-currency",
    });
    expect(parseAmount("20 eur", "EUR")).toEqual({
      ok: true,
      minorUnits: 2000,
    });
  });
});
