import { describe, expect, it } from "vitest";
import { type BodyButton, type BodyRules, inspectBody } from "./body.js";

const rules: BodyRules = {
  pair: (row) =>
    (row.length === 2 &&
      row.every((button) => button.action.startsWith("page."))) ||
    row.map((button) => button.action).join("|") ===
      "page.prev|refresh|page.next",
  maxRows: 3,
};

const button = (action: string, callbackData = `v1:${action}`): BodyButton => ({
  action,
  callbackData,
});

describe("inspectBody", () => {
  it("passes one button per row and a paging pair", () => {
    expect(
      inspectBody(
        [[button("open")], [button("page.prev"), button("page.next")]],
        rules,
      ),
    ).toEqual([]);
  });

  it("names a pair the body does not allow and a row wider than two", () => {
    expect(
      inspectBody(
        [
          [button("open"), button("page.next")],
          [button("page.prev"), button("page.next"), button("page.last")],
        ],
        rules,
      ).map(({ rule }) => rule),
    ).toEqual(["rows", "rows"]);
  });

  it("passes a row of three the rules name and refuses one of four", () => {
    const named = [button("page.prev"), button("refresh"), button("page.next")];
    expect(inspectBody([named], rules)).toEqual([]);
    expect(
      inspectBody([[...named, button("page.last")]], rules).map(
        ({ rule }) => rule,
      ),
    ).toEqual(["rows"]);
  });

  it("names a body taller than its ceiling", () => {
    const tall = [1, 2, 3, 4].map((n) => [button(`open.${n}`)]);
    expect(inspectBody(tall, rules)).toMatchObject([
      { rule: "rows", detail: "рядов 4, потолок 3" },
    ]);
  });

  it("names callback data longer than 64 bytes", () => {
    // Кириллица — два байта на знак: 33 знака уже за пределом.
    expect(inspectBody([[button("open", "ж".repeat(33))]], rules)).toEqual([
      { rule: "callback-data", detail: "данные open длиннее 64 байт" },
    ]);
  });
});
