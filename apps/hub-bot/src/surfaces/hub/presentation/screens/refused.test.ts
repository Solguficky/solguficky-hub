import { describe, expect, it } from "vitest";
import type { RefusedApplication } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { reconsiderConfirmScreen, refusedScreen } from "./refused.js";
import type { ShownScreen } from "./show.js";

// L0: экраны отказанных как данные. Правила каталога на них проверяет линтер
// test kit в тестах бота.

const today = { year: 2026, month: 10, day: 3 };

function id(index: number): string {
  return `0192f3a4-b5c6-7d8e-9f0a-${index.toString(16).padStart(12, "0")}`;
}

function refused(
  index: number,
  overrides: Partial<RefusedApplication> = {},
): RefusedApplication {
  return {
    applicationId: id(index),
    identityId: id(1000 + index),
    telegramUserId: BigInt(index),
    telegramUsername: `user${index}`,
    circle: "public",
    outcome: "blocked",
    decidedBy: { telegramUserId: 7n, telegramUsername: "admin" },
    decidedAt: { year: 2026, month: 10, day: 2, hours: 14, minutes: 5 },
    ...overrides,
  };
}

function rows(screen: ShownScreen): string[][] {
  return screen.keyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );
}

function dataOf(screen: ShownScreen, text: string): string | undefined {
  const button = screen.keyboard.inline_keyboard
    .flat()
    .find((candidate) => candidate.text === text);
  return button !== undefined && "callback_data" in button
    ? button.callback_data
    : undefined;
}

describe("refused list", () => {
  it("names the circle, the outcome, who refused and when", () => {
    const screen = refusedScreen(
      "community",
      [refused(1), refused(2, { circle: "member", outcome: "declined" })],
      0,
      today,
    );

    expect(screen.id).toBe("refused");
    expect(screen.text).toBe(
      [
        "<b>Отказанные</b>",
        "",
        "• @user1 — заявка в аукцион, заблокирован",
        "  @admin, 2 октября, пт, 14:05",
        "• @user2 — заявка в хаб, отклонена",
        "  @admin, 2 октября, пт, 14:05",
      ].join("\n"),
    );
    expect(rows(screen)).toEqual([
      ["Пересмотреть @user1 в аукцион"],
      ["Пересмотреть @user2 в хаб"],
      ["‹ Управление", "Меню"],
    ]);
    expect(dataOf(screen, "Пересмотреть @user1 в аукцион")).toBe(
      `v1:cm:rq:${uuidToToken(id(1))}:0`,
    );
  });

  it("links a person without a username by Telegram id", () => {
    const { telegramUsername: _, decidedBy: __, ...anonymous } = refused(3);
    const screen = refusedScreen("community", [anonymous], 0, today);

    expect(screen.text).toContain(
      '• <a href="tg://user?id=3">без ника</a> — заявка в аукцион, заблокирован\n  2 октября, пт, 14:05',
    );
    expect(rows(screen)[0]).toEqual(["Пересмотреть id 3 в аукцион"]);
  });

  it("pages by eight and keeps the page in the reconsider button", () => {
    const all = Array.from({ length: 10 }, (_, index) => refused(index + 1));
    const screen = refusedScreen("community", all, 1, today);

    expect(screen.text).toContain("<b>Отказанные · 2 из 2</b>");
    expect(rows(screen)).toEqual([
      ["Пересмотреть @user9 в аукцион"],
      ["Пересмотреть @user10 в аукцион"],
      ["←"],
      ["‹ Управление", "Меню"],
    ]);
    expect(dataOf(screen, "Пересмотреть @user9 в аукцион")).toBe(
      `v1:cm:rq:${uuidToToken(id(9))}:1`,
    );
  });

  it("says so when nobody is refused", () => {
    expect(refusedScreen("community", [], 0, today).text).toBe(
      "<b>Отказанные</b>\n\nПока никого.",
    );
  });

  // Снять блокировку Identity пускает по праву управлять составом: модератору
  // аукциона без него кнопка у такого отказа вела бы в отказ.
  it("offers no reconsider of a block to someone who cannot lift it", () => {
    const screen = refusedScreen(
      "auction",
      [refused(1), refused(2, { outcome: "declined" })],
      0,
      today,
      false,
    );

    expect(rows(screen)).toEqual([
      ["Пересмотреть @user2 в аукцион"],
      ["‹ Управление", "Меню"],
    ]);
  });

  it("lists the auction queue under its own title and domain", () => {
    const screen = refusedScreen(
      "auction",
      [refused(1, { outcome: "declined" })],
      0,
      today,
    );

    expect(screen.id).toBe("refused-auction");
    expect(screen.text).toContain("<b>Отказанные в аукцион</b>");
    expect(dataOf(screen, "Пересмотреть @user1 в аукцион")).toBe(
      `v1:aq:rq:${uuidToToken(id(1))}:0`,
    );
  });
});

describe("reconsider confirmation", () => {
  it("names lifting the block and granting the role", () => {
    const screen = reconsiderConfirmScreen("community", refused(1), 2);

    expect(screen.text).toBe(
      "<b>Пересмотреть отказ?</b>\n\nБлокировка @user1 снимется, и сразу откроется доступ к аукциону.",
    );
    expect(rows(screen)).toEqual([["Да, пересмотреть"], ["Нет"]]);
    expect(dataOf(screen, "Да, пересмотреть")).toBe(
      `v1:cm:ry:${uuidToToken(id(1))}:2`,
    );
    expect(dataOf(screen, "Нет")).toBe("v1:cm:r:2");
    expect(screen.keyboard.inline_keyboard[0]?.[0]).toMatchObject({
      style: "success",
    });
  });

  it("names admission by the closed application for a declined one", () => {
    const screen = reconsiderConfirmScreen(
      "community",
      refused(2, { circle: "member", outcome: "declined" }),
      0,
    );

    expect(screen.text).toBe(
      "<b>Пересмотреть отказ?</b>\n\nЗаявка @user2 в хаб будет принята: откроется доступ к сходкам сообщества.",
    );
  });
});
