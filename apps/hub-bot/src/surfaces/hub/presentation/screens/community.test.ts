import { describe, expect, it } from "vitest";
import type { CommunityMember } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  closeAccessConfirmScreen,
  communityMemberRefusalText,
  communityMemberScreen,
  communityScreen,
} from "./community.js";
import type { ShownScreen } from "./show.js";

// L0: экраны состава сообщества как данные. Что эти же экраны проходят правила
// каталога, проверяет линтер test kit на тестах бота.

function id(index: number): string {
  return `0192f3a4-b5c6-7d8e-9f0a-${index.toString(16).padStart(12, "0")}`;
}

function person(
  index: number,
  circle: CommunityMember["circle"],
  auctionModeration = false,
): CommunityMember {
  return {
    identityId: id(index),
    telegramUsername: `user${index}`,
    circle,
    auctionModeration,
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

const nav = ["‹ Состав"];
const members = { filter: "members", page: 0 } as const;

describe("community list", () => {
  const snapshot = {
    members: [
      person(1, "member"),
      person(2, "member", true),
      person(3, "guest"),
      person(4, "none"),
    ],
    allowedUsernames: ["invited"],
  };

  it("lists the members, marks the chosen filter and opens a card", () => {
    const screen = communityScreen(snapshot, { kind: "list", place: members });

    expect(screen.id).toBe("community");
    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nУчастники: 2\n\n• @user1\n• @user2 · модерирует аукцион",
    );
    expect(rows(screen)).toEqual([
      ["• Участники", "Гости"],
      ["Модераторы", "Разрешённые ники"],
      ["@user1"],
      ["@user2"],
      ["‹ Управление"],
    ]);
    expect(dataOf(screen, "@user1")).toBe(`v1:cm:v:${uuidToToken(id(1))}:m0`);
    expect(dataOf(screen, "Гости")).toBe("v1:cm:l:g0");
    expect(dataOf(screen, "Модераторы")).toBe("v1:cm:l:o0");
    expect(dataOf(screen, "Разрешённые ники")).toBe("v1:cm:u");
  });

  // Как на экране «Администраторы»: смотрящий видит себя «(ты)» в тексте, а
  // кнопка остаётся ником (PER-618).
  it("marks the viewer in the text", () => {
    const screen = communityScreen(
      snapshot,
      { kind: "list", place: members },
      { viewerId: id(2) },
    );

    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nУчастники: 2\n\n• @user1\n• @user2 (ты) · модерирует аукцион",
    );
    expect(rows(screen)).toContainEqual(["@user2"]);
  });

  it("shows the guests apart from the members", () => {
    const screen = communityScreen(snapshot, {
      kind: "list",
      place: { filter: "guests", page: 0 },
    });

    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nГости: 1\n\n• @user3",
    );
    expect(rows(screen)[0]).toEqual(["Участники", "• Гости"]);
    expect(dataOf(screen, "@user3")).toBe(`v1:cm:v:${uuidToToken(id(3))}:g0`);
  });

  it("lists the auction moderators", () => {
    const screen = communityScreen(snapshot, {
      kind: "list",
      place: { filter: "moderators", page: 0 },
    });

    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nМодераторы аукциона: 1\n\n• @user2",
    );
    expect(rows(screen)[1]).toEqual(["• Модераторы", "Разрешённые ники"]);
  });

  // Старый Identity фильтра не знает и отдаёт всех: человек без круга не
  // попадает ни в один фильтр.
  it("leaves out the people without a circle under every filter", () => {
    for (const filter of ["members", "guests", "moderators"] as const) {
      const screen = communityScreen(snapshot, {
        kind: "list",
        place: { filter, page: 0 },
      });
      expect(screen.text).not.toContain("user4");
    }
  });

  it("cuts the list into pages of eight within the row limit", () => {
    const many = {
      members: Array.from({ length: 20 }, (_, i) => person(i + 1, "member")),
      allowedUsernames: [],
    };
    const screen = communityScreen(many, {
      kind: "list",
      place: { filter: "members", page: 1 },
    });

    expect(screen.text.split("\n")[0]).toBe(
      "<b>Состав сообщества · 2 из 3</b>",
    );
    expect(rows(screen)).toHaveLength(12);
    expect(dataOf(screen, "@user9")).toBe(`v1:cm:v:${uuidToToken(id(9))}:m1`);
    expect(dataOf(screen, "←")).toBe("v1:cm:l:m0");
    expect(dataOf(screen, "→")).toBe("v1:cm:l:m2");
  });

  it("says so when nobody is in the filter", () => {
    const screen = communityScreen(
      { members: [], allowedUsernames: [] },
      { kind: "list", place: { filter: "guests", page: 0 } },
    );

    expect(screen.text).toBe(
      "<b>Состав сообщества</b>\n\nГости: 0\n\nГостей пока нет.",
    );
  });

  it("names a person without a username by the code and a mention", () => {
    const screen = communityScreen(
      {
        members: [
          {
            identityId: "01a0e306-a646-7d3a-9b21-4f8e12ab34cd",
            telegramUserId: 5001n,
            circle: "member",
            auctionModeration: false,
          },
        ],
        allowedUsernames: [],
      },
      { kind: "list", place: members },
    );

    expect(screen.text).toContain(
      '<a href="tg://user?id=5001">без ника</a> · 12ab34cd',
    );
    expect(screen.text).not.toContain("01a0e306");
    expect(rows(screen)).toContainEqual(["без ника · 12ab34cd"]);
  });
});

describe("community member card", () => {
  const place = { filter: "members", page: 2 } as const;

  it("offers moderation to a member and returns to the same page", () => {
    const screen = communityMemberScreen(person(1, "member"), place);
    const token = uuidToToken(id(1));

    expect(screen.id).toBe("community-member");
    expect(screen.text).toBe(
      "<b>Карточка человека</b>\n\n@user1\n\nКруг: участник\nМодерация аукциона: нет",
    );
    expect(rows(screen)).toEqual([
      ["Выдать модерацию"],
      ["Закрыть доступ"],
      nav,
    ]);
    expect(dataOf(screen, "Выдать модерацию")).toBe(`v1:cm:mg:${token}:m2`);
    expect(dataOf(screen, "Закрыть доступ")).toBe(`v1:cm:bq:${token}:m2`);
    expect(dataOf(screen, "‹ Состав")).toBe("v1:cm:l:m2");
  });

  it("revokes moderation from a moderator", () => {
    const screen = communityMemberScreen(person(1, "member", true), place);

    expect(screen.text).toContain("Модерация аукциона: есть");
    expect(dataOf(screen, "Снять модерацию")).toBe(
      `v1:cm:mv:${uuidToToken(id(1))}:m2`,
    );
  });

  it("offers no moderation to a guest", () => {
    const screen = communityMemberScreen(person(3, "guest"), {
      filter: "guests",
      page: 0,
    });

    expect(screen.text).toBe(
      "<b>Карточка человека</b>\n\n@user3\n\nКруг: гость",
    );
    expect(rows(screen)).toEqual([["Закрыть доступ"], nav]);
  });

  it.each([
    [{ kind: "forbidden" } as const, "без права"],
    [{ kind: "identity-unknown" } as const, "Такого человека нет в составе."],
    [{ kind: "blocked" } as const, "Доступ этому человеку уже закрыт."],
    [
      { kind: "holds-preset" } as const,
      "Это администратор: закрыть доступ или поменять модерацию отсюда нельзя. Правами администратора управляет мейнтейнер в «Участники → Администраторы».",
    ],
    [{ kind: "invalid" } as const, "недоступно"],
  ])("tells refusal %o as a screen text", (result, text) => {
    expect(communityMemberRefusalText(result, "без права", "недоступно")).toBe(
      text,
    );
  });
});

describe("community allowed usernames", () => {
  it("offers removal only for a username that fits the button data", () => {
    const long = "a".repeat(40);
    const screen = communityScreen(
      { members: [], allowedUsernames: ["alice_1", long] },
      { kind: "usernames", page: 0 },
      { notice: "Ник добавлен." },
    );

    expect(screen.text).toBe(
      `<b>Разрешённые ники</b>\n\nНик добавлен.\n\n• @alice_1\n• @${long}`,
    );
    expect(rows(screen)).toEqual([
      ["🗑 Убрать @alice_1"],
      ["Добавить ник"],
      ["🔄 Обновить"],
      nav,
    ]);
    expect(dataOf(screen, "🗑 Убрать @alice_1")).toBe("v1:cm:rm:0:alice_1");
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
    expect(dataOf(screen, "🗑 Убрать @nick8")).toBe("v1:cm:rm:1:nick8");
  });
});

describe("closing access", () => {
  it("asks with a red confirmation and returns to the card", () => {
    const place = { filter: "guests", page: 1 } as const;
    const screen = closeAccessConfirmScreen(person(3, "guest"), place);
    const token = uuidToToken(id(3));

    expect(screen.id).toBe("community-close-confirm");
    expect(screen.text).toBe(
      "<b>Закрыть доступ?</b>\n\n@user3 перестанет видеть сходки сообщества. Вернуть доступ из бота нельзя.",
    );
    expect(rows(screen)).toEqual([["✔️ Да, закрыть доступ", "✖️ Нет"]]);
    expect(dataOf(screen, "✔️ Да, закрыть доступ")).toBe(`v1:cm:by:${token}:g1`);
    expect(dataOf(screen, "✖️ Нет")).toBe(`v1:cm:v:${token}:g1`);
    const yes = screen.keyboard.inline_keyboard[0]?.[0];
    expect(yes !== undefined && "style" in yes ? yes.style : undefined).toBe(
      "danger",
    );
  });
});
