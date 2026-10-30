import { describe, expect, it } from "vitest";
import {
  autoRaisedLine,
  autoRaisedLines,
  favoritesEmpty,
  favoritesEmptyText,
  favoritesSummary,
  feedSummary,
  finalFeedLabel,
  lotButtonTail,
  lotGroupPrefix,
  overtakenByProxyLine,
} from "./auction-standing.js";
import type { FeedItem } from "./auction-ui/index.js";
import { money } from "./core/format.js";

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

describe("finalFeedLabel", () => {
  it("shortens the title, not the price, to fit the button", () => {
    const item: FeedItem = {
      lotId: "lot-1",
      status: { kind: "held", currentPrice: rub(1000) },
    };
    const label = finalFeedLabel(item, {}, "Я".repeat(60)) ?? "";
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.startsWith("🏁 ")).toBe(true);
    expect(label.endsWith(` · в составе · ${money(rub(1000))}`)).toBe(true);
  });
});

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

// Перерыв перед финалом (PER-833): лидер лота, который ждёт финала, видит его
// в сводке своим, а «не лидируешь» остаётся тому, кто нигде не лидирует.
describe("feed summary in the break before the final", () => {
  const held: FeedItem = {
    lotId: "lot-2",
    title: "Ваза",
    status: { kind: "held", currentPrice: rub(900), leaderId: "viewer" },
    standing: "leader",
  };

  it("names the held lot of the leader instead of denying the leadership", () => {
    const text = feedSummary({ lots: [held], mine: [held] }, mineOptions).join(
      " ",
    );
    expect(text).toContain("Ваза — 1 200 ₽, ты лидер");
    expect(text).not.toContain("не лидируешь");
  });

  it("keeps the denial for someone who leads nowhere", () => {
    const { standing: _standing, ...other } = held;
    const text = feedSummary({ lots: [other] }, mineOptions).join(" ");
    expect(text).toContain("Ты пока не лидируешь");
  });
});

// PER-840: слова об автоставках одни у двух ботов, онлайн-недели и финала.
describe("proxy wording", () => {
  it("names the proxy that overtook a manual bid with the price", () => {
    expect(
      overtakenByProxyLine({ minorUnits: 120000, currency: "RUB" }),
    ).toContain("Тебя перебила автоставка другого участника, цена 1");
  });

  it("says the price rose automatically only for a flagged card", () => {
    expect(autoRaisedLines({ autoRaised: true })).toEqual([autoRaisedLine]);
    expect(autoRaisedLines({})).toEqual([]);
  });
});
