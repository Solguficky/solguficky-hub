import { describe, expect, it } from "vitest";
import type { ApplicationCard } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  ageLabel,
  applicationCardScreen,
  applicationQueueEndScreen,
  decisionToast,
  declineConfirmScreen,
} from "./application.js";
import type { ShownScreen } from "./show.js";

const applicationId = "0192f3a4-b5c6-7d8e-9f0a-00000000a001";
const createdAtMs = Date.parse("2026-10-02T11:05:00.123Z");
const cursor = `${uuidToToken(applicationId)}:${createdAtMs.toString(36)}`;
const card: ApplicationCard = {
  applicationId,
  identityId: "0192f3a4-b5c6-7d8e-9f0a-0000c0de1234",
  telegramUserId: 77n,
  telegramUsername: "ivan_p",
  firstName: "Иван П.",
  circle: "public",
  source: { kind: "channel", label: "Солегуфики" },
  createdAtMs,
};
const twoDaysLater = createdAtMs + 2 * 24 * 60 * 60_000;

function rows(keyboard: ShownScreen["keyboard"]): string[][] {
  return keyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );
}

describe("application card", () => {
  it("shows position, circle, person, source and age", () => {
    const screen = applicationCardScreen(
      { application: card, position: 3 },
      17,
      twoDaysLater,
    );

    expect(screen.text).toBe(
      "<b>Заявка 3 из 17 · аукцион</b>\n\nИван П. (@ivan_p)\nПришёл: канал «Солегуфики» · 2 дня назад",
    );
    expect(screen.keyboard.inline_keyboard).toEqual([
      [{ text: "Допустить", callback_data: `v1:cm:qa:${cursor}` }],
      [{ text: "Отказать", callback_data: `v1:cm:qd:${cursor}` }],
      [{ text: "Профиль ↗", url: "tg://user?id=77" }],
      [{ text: "Пропустить", callback_data: `v1:cm:q:${cursor}` }],
      [
        { text: "‹ Управление", callback_data: "v1:manage:menu" },
        { text: "Меню", callback_data: "v1:nav:start" },
      ],
    ]);
  });

  it("falls back to the username link when privacy hides the profile", () => {
    const screen = applicationCardScreen(
      { application: card, position: 1 },
      1,
      twoDaysLater,
    );

    expect(screen.privacyFallback?.inline_keyboard[2]).toEqual([
      { text: "Профиль ↗", url: "https://t.me/ivan_p" },
    ]);
  });

  it("names a person without a username by name and code, without a profile fallback", () => {
    const { telegramUsername: _, ...withoutUsername } = card;
    const screen = applicationCardScreen(
      {
        application: { ...withoutUsername, circle: "member" },
        position: 1,
      },
      2,
      twoDaysLater,
    );

    expect(screen.text).toContain("<b>Заявка 1 из 2 · хаб</b>");
    expect(screen.text).toContain("Иван П. · код c0de1234");
    expect(screen.text).not.toContain(card.identityId);
    expect(rows(screen.privacyFallback ?? screen.keyboard)).toEqual([
      ["Допустить"],
      ["Отказать"],
      ["Пропустить"],
      ["‹ Управление", "Меню"],
    ]);
  });

  it.each([
    [{ kind: "unknown" } as const, "Пришёл: неизвестный канал"],
    [{ kind: "none" } as const, "Пришёл: напрямую"],
  ])("captions the source %o", (source, caption) => {
    const screen = applicationCardScreen(
      { application: { ...card, source }, position: 1 },
      1,
      twoDaysLater,
    );

    expect(screen.text).toContain(caption);
  });

  it("escapes the name and the channel label", () => {
    const screen = applicationCardScreen(
      {
        application: {
          ...card,
          firstName: "<b>",
          source: { kind: "channel", label: "A&B" },
        },
        position: 1,
      },
      1,
      twoDaysLater,
    );

    expect(screen.text).toContain("&lt;b&gt; (@ivan_p)");
    expect(screen.text).toContain("канал «A&amp;B»");
  });
});

describe("application age", () => {
  const minute = 60_000;
  it.each([
    [0, "только что"],
    [1 * minute, "1 минуту назад"],
    [3 * minute, "3 минуты назад"],
    [11 * minute, "11 минут назад"],
    [21 * minute, "21 минуту назад"],
    [60 * minute, "1 час назад"],
    [22 * 60 * minute, "22 часа назад"],
    [5 * 24 * 60 * minute, "5 дней назад"],
    [-5 * minute, "только что"],
  ])("reads %i ms as «%s»", (elapsed, label) => {
    expect(ageLabel(createdAtMs, createdAtMs + elapsed)).toBe(label);
  });
});

describe("application queue end", () => {
  it("says the queue is empty", () => {
    const screen = applicationQueueEndScreen(0, false);

    expect(screen.text).toBe("<b>Заявки</b>\n\nНовых заявок нет.");
    expect(rows(screen.keyboard)).toEqual([["‹ Управление", "Меню"]]);
  });

  it("says the queue ended and offers the skipped ones from the start", () => {
    const screen = applicationQueueEndScreen(2, true);

    expect(screen.text).toBe(
      "<b>Заявки</b>\n\nОчередь кончилась. Пропущенных заявок: 2.",
    );
    expect(screen.keyboard.inline_keyboard[0]).toEqual([
      { text: "С начала", callback_data: "v1:cm:q" },
    ]);
  });
});

describe("decline confirmation", () => {
  it("names the block for the auction circle", () => {
    const screen = declineConfirmScreen(card);

    expect(screen.text).toBe(
      "<b>Отказать?</b>\n\nПрофиль Иван П. (@ivan_p) будет заблокирован: доступа к аукциону не будет.",
    );
    expect(screen.keyboard.inline_keyboard).toEqual([
      [
        {
          text: "Да, отказать",
          callback_data: `v1:cm:qy:${cursor}`,
          style: "danger",
        },
      ],
      [{ text: "Нет", callback_data: `v1:cm:qc:${cursor}` }],
    ]);
  });

  it("keeps the auction for a refusal of the hub circle", () => {
    expect(declineConfirmScreen({ ...card, circle: "member" }).text).toContain(
      "в хаб будет отклонена. Доступ к аукциону, если он есть, останется.",
    );
  });
});

describe("decision toast", () => {
  it.each([
    [{ already: false, outcome: "admitted" } as const, "Человек допущен."],
    [{ already: false, outcome: "declined" } as const, "Заявка отклонена."],
    [
      { already: false, outcome: "blocked" } as const,
      "Отказано: профиль заблокирован.",
    ],
    [
      {
        already: true,
        outcome: "admitted",
        decidedBy: { telegramUserId: 7n, telegramUsername: "admin" },
      } as const,
      "Уже решено: допущен, @admin.",
    ],
    [
      {
        already: true,
        outcome: "blocked",
        decidedBy: { telegramUserId: 7n },
      } as const,
      "Уже решено: заблокирован, id 7.",
    ],
    [
      { already: true, outcome: "closed-by-grant" } as const,
      "Уже решено: доступ выдан без заявки, по разрешённому нику.",
    ],
  ])("answers %o", (decision, toast) => {
    expect(decisionToast(decision)).toBe(toast);
  });
});
