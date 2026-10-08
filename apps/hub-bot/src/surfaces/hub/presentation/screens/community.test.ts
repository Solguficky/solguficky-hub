import { describe, expect, it } from "vitest";
import type { CommunityMember } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  closeAccessConfirmScreen,
  communityScreen,
  viewOfOrigin,
} from "./community.js";
import type { ShownScreen } from "./show.js";

// L0: экраны состава сообщества как данные. Что эти же экраны проходят правила
// каталога, проверяет линтер test kit на тестах бота.

function id(index: number): string {
  return `0192f3a4-b5c6-7d8e-9f0a-${index.toString(16).padStart(12, "0")}`;
}

function person(index: number, admitted: boolean): CommunityMember {
  return { identityId: id(index), telegramUsername: `user${index}`, admitted };
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

const nav = ["‹ Состав", "Меню"];

describe("community root", () => {
  it("shows the three counts and leads to the three lists", () => {
    const screen = communityScreen(
      {
        members: [person(1, false), person(2, true), person(3, true)],
        allowedUsernames: ["invited"],
      },
      { kind: "root" },
    );

    expect(screen.id).toBe("community");
    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nОжидают допуска: 1\nДопущены: 2\nРазрешённые ники: 1",
    );
    expect(rows(screen)).toEqual([
      ["Ожидают допуска"],
      ["Допущенные"],
      ["Разрешённые ники"],
      ["Обновить"],
      ["‹ Управление", "Меню"],
    ]);
  });
});

describe("community pending queue", () => {
  const queue = [person(1, false), person(2, false), person(3, false)];
  const snapshot = { members: queue, allowedUsernames: [] };
  const [first, second, third] = queue.map((member) =>
    uuidToToken(member.identityId),
  );

  it("shows one person and carries the next one as the cursor", () => {
    const screen = communityScreen(snapshot, { kind: "pending" });

    expect(screen.text).toBe(
      "<b>Ожидают допуска</b>\n\n@user1\n\nВ очереди: 3",
    );
    expect(rows(screen)).toEqual([
      ["Допустить"],
      ["Закрыть"],
      ["Пропустить"],
      ["Обновить"],
      nav,
    ]);
    expect(dataOf(screen, "Допустить")).toBe(`v1:cm:ad:${first}:${second}`);
    expect(dataOf(screen, "Закрыть")).toBe(`v1:cm:bq:${first}:p${second}`);
    expect(dataOf(screen, "Пропустить")).toBe(`v1:cm:p:${second}`);
    expect(dataOf(screen, "Обновить")).toBe(`v1:cm:p:${first}`);
  });

  it("wraps from the last person back to the first", () => {
    const screen = communityScreen(snapshot, {
      kind: "pending",
      cursor: id(3),
    });

    expect(screen.text).toContain("@user3");
    expect(dataOf(screen, "Пропустить")).toBe(`v1:cm:p:${first}`);
    expect(dataOf(screen, "Допустить")).toBe(`v1:cm:ad:${third}:${first}`);
  });

  it("falls back to the head of the queue when the cursor is gone", () => {
    const screen = communityScreen(snapshot, {
      kind: "pending",
      cursor: id(99),
    });

    expect(screen.text).toContain("@user1");
  });

  it("has nobody to skip to in a queue of one", () => {
    const screen = communityScreen(
      { members: [person(1, false)], allowedUsernames: [] },
      { kind: "pending" },
    );

    expect(rows(screen)).toEqual([
      ["Допустить"],
      ["Закрыть"],
      ["Обновить"],
      nav,
    ]);
    expect(dataOf(screen, "Допустить")).toBe(`v1:cm:ad:${first}`);
    expect(dataOf(screen, "Закрыть")).toBe(`v1:cm:bq:${first}:p`);
  });

  it("says the queue is empty and keeps only navigation", () => {
    const screen = communityScreen(
      { members: [person(1, true)], allowedUsernames: [] },
      { kind: "pending" },
    );

    expect(screen.text).toBe("<b>Ожидают допуска</b>\n\nОчередь пуста.");
    expect(rows(screen)).toEqual([nav]);
  });

  it("names a person without a username by the code and a mention", () => {
    const screen = communityScreen(
      {
        members: [
          {
            identityId: "01a0e306-a646-7d3a-9b21-4f8e12ab34cd",
            telegramUserId: 5001n,
            admitted: false,
          },
        ],
        allowedUsernames: [],
      },
      { kind: "pending" },
    );

    expect(screen.text).toContain(
      '<a href="tg://user?id=5001">без ника</a> · 12ab34cd',
    );
    expect(screen.text).not.toContain("01a0e306");
  });
});

describe("community admitted list", () => {
  const members = Array.from({ length: 11 }, (_, index) =>
    person(index + 1, true),
  );
  const snapshot = { members, allowedUsernames: [] };

  it("cuts the list into pages of eight and keeps the page in every button", () => {
    const screen = communityScreen(snapshot, { kind: "admitted", page: 1 });

    expect(screen.text).toBe(
      "<b>Допущенные · 2 из 2</b>\n\n• @user9\n• @user10\n• @user11",
    );
    expect(rows(screen)).toEqual([
      ["Закрыть @user9"],
      ["Закрыть @user10"],
      ["Закрыть @user11"],
      ["←"],
      ["Обновить"],
      nav,
    ]);
    expect(dataOf(screen, "Закрыть @user9")).toBe(
      `v1:cm:bq:${uuidToToken(id(9))}:a1`,
    );
    expect(dataOf(screen, "←")).toBe("v1:cm:a:0");
    expect(dataOf(screen, "Обновить")).toBe("v1:cm:a:1");
  });

  it("fits a full page into the row limit", () => {
    const screen = communityScreen(snapshot, { kind: "admitted", page: 0 });

    expect(rows(screen)).toHaveLength(11);
  });

  it("names a person without a username by the code in the button", () => {
    const screen = communityScreen(
      {
        members: [
          {
            identityId: "01a0e306-918c-7e01-8c55-0d2f6a7b9e10",
            admitted: true,
          },
        ],
        allowedUsernames: [],
      },
      { kind: "admitted", page: 0 },
    );

    expect(screen.text).toContain("• без ника · 6a7b9e10");
    expect(rows(screen)[0]).toEqual(["Закрыть без ника · 6a7b9e10"]);
  });

  it("says so when nobody is admitted", () => {
    const screen = communityScreen(
      { members: [], allowedUsernames: [] },
      { kind: "admitted", page: 0 },
    );

    expect(screen.text).toBe("<b>Допущенные</b>\n\nПока никого.");
    expect(rows(screen)).toEqual([["Обновить"], nav]);
  });
});

describe("community allowed usernames", () => {
  it("offers removal only for a username that fits the button data", () => {
    const long = "a".repeat(40);
    const screen = communityScreen(
      { members: [], allowedUsernames: ["alice_1", long] },
      { kind: "usernames", page: 0 },
      "Ник добавлен.",
    );

    expect(screen.text).toBe(
      `<b>Разрешённые ники</b>\n\nНик добавлен.\n\n• @alice_1\n• @${long}`,
    );
    expect(rows(screen)).toEqual([
      ["Убрать @alice_1"],
      ["Добавить ник"],
      ["Обновить"],
      nav,
    ]);
    expect(dataOf(screen, "Убрать @alice_1")).toBe("v1:cm:rm:0:alice_1");
  });

  it("fits a full page into the row limit", () => {
    const screen = communityScreen(
      {
        members: [],
        allowedUsernames: Array.from({ length: 20 }, (_, i) => `nick${i}`),
      },
      { kind: "usernames", page: 1 },
    );

    expect(rows(screen)).toHaveLength(12);
    expect(dataOf(screen, "Убрать @nick8")).toBe("v1:cm:rm:1:nick8");
  });
});

describe("closing access", () => {
  const member = person(1, true);
  const token = uuidToToken(member.identityId);

  it("asks with a plain confirmation and returns to the same page", () => {
    const screen = closeAccessConfirmScreen(member, {
      kind: "admitted",
      page: 2,
    });

    expect(screen.id).toBe("community-close-confirm");
    expect(screen.keyboard.inline_keyboard).toEqual([
      [
        {
          text: "Да, закрыть доступ",
          callback_data: `v1:cm:by:${token}:a2`,
        },
      ],
      [{ text: "Нет", callback_data: "v1:cm:a:2" }],
    ]);
  });

  it("returns a refusal to the same person in the queue", () => {
    const next = uuidToToken(id(2));
    const screen = closeAccessConfirmScreen(member, { kind: "pending", next });

    expect(dataOf(screen, "Да, закрыть доступ")).toBe(
      `v1:cm:by:${token}:p${next}`,
    );
    expect(dataOf(screen, "Нет")).toBe(`v1:cm:p:${token}`);
  });

  it("moves on to the next person once access is closed", () => {
    expect(viewOfOrigin({ kind: "pending", next: uuidToToken(id(2)) })).toEqual(
      { kind: "pending", cursor: id(2) },
    );
    expect(viewOfOrigin({ kind: "pending" })).toEqual({ kind: "pending" });
    expect(viewOfOrigin({ kind: "admitted", page: 3 })).toEqual({
      kind: "admitted",
      page: 3,
    });
  });
});
