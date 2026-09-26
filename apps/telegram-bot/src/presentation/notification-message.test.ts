import { GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type {
  MeetupWhen,
  RenderableContent,
} from "../delivery/notification.js";
import {
  classifySendFailure,
  createNotificationSender,
  disablePublishedCallback,
  renderNotification,
} from "./notification-message.js";

const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf";

function content(
  when: MeetupWhen,
  overrides: { title?: string; venue?: string } = {},
): RenderableContent {
  return {
    kind: "meetup-published",
    meetup: {
      id: meetupId,
      title: overrides.title ?? "Настолки у Лёши",
      venue: overrides.venue ?? "Циферблат",
      when,
    },
  };
}

function grammyError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    "call failed",
    {
      ok: false,
      error_code: code,
      description: "failed",
      ...(retryAfter === undefined
        ? {}
        : { parameters: { retry_after: retryAfter } }),
    },
    "sendMessage",
    {},
  );
}

describe("renderNotification", () => {
  it("names the meetup, when and where, with two buttons", () => {
    const message = renderNotification(
      content({
        kind: "day-start",
        tentative: false,
        at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
      }),
    );
    expect(message.text).toBe(
      "Новая сходка: Настолки у Лёши\n12.08.2026 19:00\nМесто: Циферблат",
    );
    const rows = message.keyboard.inline_keyboard;
    expect(rows[0]?.[0]).toMatchObject({ text: "Открыть сходку" });
    expect(rows[0]?.[0]).toHaveProperty(
      "callback_data",
      "v1:view:AZjypHwefTqbIU-OEqs0zw",
    );
    expect(rows[1]?.[0]).toMatchObject({
      text: "Не присылать новые сходки",
      callback_data: disablePublishedCallback,
    });
  });

  it("does not promise a precision the meetup does not have", () => {
    const text = (when: MeetupWhen) =>
      renderNotification(content(when, { venue: "" })).text.split("\n")[1];
    expect(text({ kind: "no-date" })).toBe("Дата пока не назначена");
    expect(
      text({
        kind: "day",
        tentative: true,
        date: { year: 2026, month: 8, day: 12 },
      }),
    ).toBe("Предварительно: 12.08.2026");
    expect(
      text({
        kind: "interval",
        tentative: false,
        start: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
        end: { year: 2026, month: 8, day: 12, hours: 22, minutes: 30 },
      }),
    ).toBe("12.08.2026 19:00–22:30");
    expect(
      text({
        kind: "interval",
        tentative: false,
        start: { year: 2026, month: 8, day: 12, hours: 22, minutes: 0 },
        end: { year: 2026, month: 8, day: 13, hours: 2, minutes: 0 },
      }),
    ).toBe("12.08.2026 22:00–13.08.2026 02:00");
  });

  it("omits an empty venue line", () => {
    const message = renderNotification(
      content({ kind: "no-date" }, { venue: " " }),
    );
    expect(message.text).not.toContain("Место");
  });

  it("keeps the disable button within the 64-byte budget", () => {
    expect(Buffer.byteLength(disablePublishedCallback)).toBeLessThanOrEqual(64);
  });
});

describe("notification sender", () => {
  it("sends to the private chat of the recipient", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    await expect(
      sender.send({
        telegramUserId: 42n,
        content: content({ kind: "no-date" }),
      }),
    ).resolves.toEqual({ kind: "sent" });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Новая сходка"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it("classifies Telegram refusals by what a retry can change", () => {
    expect(classifySendFailure(grammyError(403)).kind).toBe("bot-blocked");
    expect(classifySendFailure(grammyError(429, 7))).toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 7_000,
    });
    expect(classifySendFailure(grammyError(502)).kind).toBe("unavailable");
    expect(classifySendFailure(grammyError(400)).kind).toBe("rejected");
    expect(
      classifySendFailure(new HttpError("network", new Error("reset"))).kind,
    ).toBe("unavailable");
  });
});
