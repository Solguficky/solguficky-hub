import { describe, expect, it } from "vitest";
import type { SourceChannel } from "../../identity/port.js";
import { pageSize } from "./kit.js";
import type { ShownScreen } from "./show.js";
import { sourceChannelPage, sourceChannelsScreen } from "./source-channels.js";

// L0: экран каналов прихода как данные. Правила каталога на нём проверяет
// линтер test kit в тестах бота.

function channel(index: number): SourceChannel {
  return {
    code: `c${String(index).padStart(2, "0")}`,
    label: `Канал ${index}`,
  };
}

function rows(screen: ShownScreen): string[][] {
  return screen.keyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );
}

describe("sourceChannelsScreen", () => {
  it("shows label, code and a link into each bot", () => {
    const screen = sourceChannelsScreen(
      [{ code: "tg_ads", label: "Реклама <в канале>" }],
      0,
      { hub: "hub_bot", auction: "auction_bot" },
    );
    expect(screen.id).toBe("source-channels");
    expect(screen.text).toContain("Реклама &lt;в канале&gt; · tg_ads");
    expect(screen.text).toContain("Хаб: https://t.me/hub_bot?start=s_tg_ads");
    expect(screen.text).toContain(
      "Аукцион: https://t.me/auction_bot?start=s_tg_ads",
    );
    expect(rows(screen)).toEqual([["Завести канал"], ["‹ Управление", "Меню"]]);
  });

  it("leaves out the auction link when the bot is not named", () => {
    const screen = sourceChannelsScreen([channel(1)], 0, { hub: "hub_bot" });
    expect(screen.text).toContain("Хаб: https://t.me/hub_bot?start=s_c01");
    expect(screen.text).not.toContain("Аукцион:");
  });

  it("says the list is empty and still offers a new channel", () => {
    const screen = sourceChannelsScreen([], 0, { hub: "hub_bot" });
    expect(screen.text).toContain("Пока ни одного.");
    expect(rows(screen)[0]).toEqual(["Завести канал"]);
  });

  it("pages a long list and finds the page of a channel", () => {
    const channels = Array.from({ length: pageSize + 2 }, (_, index) =>
      channel(index),
    );
    const second = sourceChannelsScreen(channels, 1, { hub: "hub_bot" });
    expect(second.text).toContain("Каналы прихода · 2 из 2");
    expect(second.text).toContain(`s_${channels[pageSize]?.code}`);
    expect(rows(second)).toContainEqual(["←"]);
    expect(sourceChannelPage(channels, channels[pageSize]?.code ?? "")).toBe(1);
    expect(sourceChannelPage(channels, "missing")).toBe(0);
  });

  it("puts a notice above the list", () => {
    const screen = sourceChannelsScreen(
      [channel(1)],
      0,
      { hub: "hub_bot" },
      "Канал заведён.",
    );
    expect(screen.text.indexOf("Канал заведён.")).toBeLessThan(
      screen.text.indexOf("Канал 1"),
    );
  });
});
