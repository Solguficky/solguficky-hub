import { InlineKeyboard } from "grammy";
import { describe, expect, it } from "vitest";
import {
  type AuctionStageView,
  encodeAuctionCallback,
} from "../../../../auction-ui/index.js";
import { eventsScreen, isAuctionEvent } from "./events.js";
import { auctionEntryOf, keyboardViaEvents, viaEvents } from "./kit.js";

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const today = { year: 2026, month: 10, day: 16 };

const summary = (stage: AuctionStageView) => ({
  auctionId,
  stage,
  opensAt: "2026-10-12T09:00:00Z",
  closesAt: "2026-10-18T14:00:00Z",
  final: true,
});

describe("auction entry from the events", () => {
  // Отметка входа — домен той же длины (PER-669): кнопка не растёт, и самое
  // длинное подтверждение ставки остаётся в 64 байтах.
  it("swaps the domain back and forth without changing the length", () => {
    const commit = encodeAuctionCallback({
      kind: "commit",
      command: "bid",
      lotId,
      opId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      amount: 999_999,
      page: 99,
    });
    const marked = viaEvents(commit);
    expect(marked.startsWith("v1:aue:")).toBe(true);
    expect(Buffer.byteLength(marked)).toBe(Buffer.byteLength(commit));
    expect(auctionEntryOf(marked)).toEqual({ data: commit, entry: "events" });
    expect(auctionEntryOf(commit)).toEqual({ data: commit, entry: "meetup" });
  });

  it("marks only the tree buttons of a keyboard", () => {
    const keyboard = keyboardViaEvents(
      new InlineKeyboard()
        .text(
          "Лоты",
          encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
        )
        .row()
        .text("Изменить лот", "v1:lot:form:abc"),
    );
    expect(
      keyboard.inline_keyboard
        .flat()
        .map((button) =>
          "callback_data" in button ? button.callback_data : undefined,
        ),
    ).toEqual([
      encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }).replace(
        "v1:auc:",
        "v1:aue:",
      ),
      "v1:lot:form:abc",
    ]);
  });
});

describe("eventsScreen", () => {
  // Аукцион — событие от онлайн-торгов до конца финала (PER-669).
  // Опубликованный запланированный аукцион — тоже событие (решение владельца
  // 24.10.2026); скрытый — нет.
  it("counts the auction as an event from its publication to the end of the final", () => {
    const going = (
      [
        "draft",
        "scheduled",
        "prebidding",
        "settling",
        "on-break",
        "lineup-frozen",
        "in-final",
        "finished",
      ] as const
    ).filter((stage) => isAuctionEvent(summary(stage)));
    expect(going).toEqual([
      "scheduled",
      "prebidding",
      "settling",
      "on-break",
      "lineup-frozen",
      "in-final",
    ]);
  });

  it("leaves a hidden scheduled auction out of the events", () => {
    expect(isAuctionEvent({ ...summary("scheduled"), hidden: true })).toBe(
      false,
    );
  });

  it("lists a going auction with its entry and returns to the menu", () => {
    const screen = eventsScreen(
      [{ kind: "auction", auctionId, auction: summary("in-final") }],
      "Europe/Moscow",
      today,
    );
    expect(screen.text).toContain("🏷️ Аукцион: идёт финал");
    const buttons = screen.keyboard.inline_keyboard.map((row) =>
      row.map((button) => button.text),
    );
    expect(buttons).toEqual([["🏷️ Аукцион"], ["‹ Меню"]]);
  });

  it("says that nothing goes when there is no event", () => {
    const screen = eventsScreen([], "Europe/Moscow", today);
    expect(screen.text).toContain(
      "Сейчас не идут события, привязанные к сходкам.",
    );
  });
});
