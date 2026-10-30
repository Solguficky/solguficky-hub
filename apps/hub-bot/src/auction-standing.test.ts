import { describe, expect, it } from "vitest";
import {
  favoritesEmpty,
  favoritesEmptyText,
  favoritesSummary,
  lotButtonTail,
  lotGroupPrefix,
} from "./auction-standing.js";
import type { FeedItem } from "./auction-ui/index.js";

const rub = (rubles: number) => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});

const item = (standing?: FeedItem["standing"]): FeedItem => ({
  lotId: "lot-1",
  title: "Кружка",
  status: { kind: "sold", winnerId: "viewer", price: rub(3000) },
  ...(standing === undefined ? {} : { standing }),
});

const mineOptions = {
  title: (each: FeedItem) => each.title ?? "",
  price: () => "1 200 ₽",
};

describe("lotGroupPrefix", () => {
  const withStatus = (status: FeedItem["status"]): FeedItem => ({
    lotId: "lot-1",
    status,
  });

  it("gives every group of the list its own sign", () => {
    expect(
      [
        { kind: "trading", currentPrice: rub(1200) },
        { kind: "held", currentPrice: rub(400) },
        { kind: "sold", winnerId: "w", price: rub(900) },
        { kind: "unsold" },
      ].map((status) =>
        lotGroupPrefix(withStatus(status as FeedItem["status"])),
      ),
    ).toEqual(["🔥 ", "🏁 ", "🤝 ", "💤 "]);
  });

  it("leaves lots outside the groups without a sign", () => {
    expect(lotGroupPrefix(withStatus({ kind: "draft" }))).toBe("");
    expect(lotGroupPrefix(withStatus({ kind: "withdrawn" }))).toBe("");
  });
});

describe("lotButtonTail", () => {
  // Прогон 14.10, №83: лидер видит себя и на кнопке ленты — словом.
  it("names the leader after the price", () => {
    expect(lotButtonTail(item("leader"), "1 200 ₽")).toBe(
      " · 1 200 ₽ · ты лидер",
    );
  });

  it("keeps the price alone for anyone else", () => {
    expect(lotButtonTail(item(), "1 200 ₽")).toBe(" · 1 200 ₽");
  });
});

describe("favorites of a finished auction", () => {
  // Прогон 14.10, №106: у закончившегося аукциона нет «пока».
  it("speaks of the results instead of the leadership", () => {
    const [line] = favoritesSummary(2, [], { ...mineOptions, ended: true });
    expect(line).toBe(
      "Аукцион закончен. Лотов в избранном: 2. Итоги — кнопками ниже.",
    );
    expect(line).not.toContain("пока");
  });

  it("lists what the viewer bought under the results", () => {
    const paragraphs = favoritesSummary(2, [item()], {
      ...mineOptions,
      ended: true,
    });
    expect(paragraphs[0]).toBe(
      "Аукцион закончен. Лотов в избранном: 2. Списком — что ты купил. Итоги всех — кнопками ниже.",
    );
    expect(paragraphs).toHaveLength(2);
  });

  it("keeps the running wording while the auction goes on", () => {
    expect(favoritesSummary(2, [], mineOptions)[0]).toContain(
      "Ты пока не лидируешь",
    );
  });

  it("does not invite to fill an empty list of a finished auction", () => {
    expect(favoritesEmptyText(true)).toBe(
      "Аукцион закончен. Избранное этого аукциона больше не хранится.",
    );
    expect(favoritesEmptyText(undefined)).toBe(favoritesEmpty);
  });
});
