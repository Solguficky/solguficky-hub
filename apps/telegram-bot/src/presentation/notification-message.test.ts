import { GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type {
  MeetupAspect,
  MeetupLifecycle,
  MeetupWhen,
  NotifiedMeetup,
  RenderableContent,
} from "../delivery/notification.js";
import {
  classifySendFailure,
  createNotificationSender,
  disableMeetupCategoryCallback,
  disablePublishedCallback,
  disableReminderCallback,
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
      kind: "",
      when,
    },
  };
}

const meetup: NotifiedMeetup = {
  id: meetupId,
  title: "Настолки у Лёши",
  venue: "Циферблат",
  kind: "Настолки",
  when: {
    kind: "day-start",
    tentative: false,
    at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
  },
};

function changed(
  aspects: MeetupAspect[],
  lifecycle: MeetupLifecycle = "planned",
  visibility: "hidden" | "visible" = "visible",
): RenderableContent {
  return { kind: "meetup-changed", meetup, aspects, lifecycle, visibility };
}

function buttons(content: RenderableContent): unknown[] {
  return (renderNotification(content).keyboard?.inline_keyboard ?? []).flat();
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
    const rows = message.keyboard?.inline_keyboard ?? [];
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

describe("reminder notification", () => {
  it("names the meetup, when and where, and offers to stop reminders", () => {
    const message = renderNotification({ kind: "meetup-reminder", meetup });
    expect(message.text).toBe(
      "Напоминание: Настолки у Лёши\n12.08.2026 19:00\nМесто: Циферблат",
    );
    const rows = message.keyboard?.inline_keyboard ?? [];
    expect(rows[0]?.[0]).toMatchObject({
      text: "Открыть сходку",
      callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zw",
    });
    expect(rows[1]?.[0]).toMatchObject({
      text: "Не присылать напоминания",
      callback_data: disableReminderCallback,
    });
    expect(Buffer.byteLength(disableReminderCallback)).toBeLessThanOrEqual(64);
  });
});

describe("change notification", () => {
  it("says what changed and shows the current values", () => {
    expect(renderNotification(changed(["venue", "schedule"])).text).toBe(
      "Изменения в сходке: Настолки у Лёши\nИзменилось: место, дата и время\n12.08.2026 19:00\nМесто: Циферблат",
    );
  });

  // Описание и ссылка на календарь только называются: карточку целиком
  // уведомление не дублирует, за подробностями ведёт кнопка.
  it("names the description without repeating it", () => {
    expect(
      renderNotification(changed(["description", "calendar-link"])).text,
    ).toContain("Изменилось: описание, ссылка на календарь");
  });

  it("leads with a cancellation and drops the details that no longer matter", () => {
    expect(renderNotification(changed(["lifecycle"], "cancelled")).text).toBe(
      "Сходка отменена: Настолки у Лёши",
    );
  });

  it("keeps other changes next to the new state", () => {
    expect(
      renderNotification(changed(["lifecycle", "title"], "held")).text,
    ).toBe(
      "Сходка состоялась: Настолки у Лёши\nИзменилось: название\n12.08.2026 19:00\nМесто: Циферблат",
    );
  });

  it("names a return to publication", () => {
    expect(
      renderNotification(changed(["visibility"])).text.split("\n")[0],
    ).toBe("Сходка снова опубликована: Настолки у Лёши");
  });

  it("shows a return to plans as the current status", () => {
    expect(renderNotification(changed(["lifecycle"])).text).toContain(
      "Статус: запланирована",
    );
  });

  it("shows the new kind", () => {
    expect(renderNotification(changed(["kind"])).text).toContain(
      "Вид: Настолки",
    );
  });

  it("names an aspect from a newer schema instead of hiding it", () => {
    expect(renderNotification(changed(["other"])).text).toContain(
      "Изменилось: другие сведения",
    );
  });

  it("opens the meetup and disables changes for this meetup only", () => {
    expect(buttons(changed(["title"]))).toEqual([
      expect.objectContaining({
        text: "Открыть сходку",
        callback_data: "v1:view:AZjypHwefTqbIU-OEqs0zw",
      }),
      expect.objectContaining({
        callback_data: "v1:notify:moff:AZjypHwefTqbIU-OEqs0zw:changes",
      }),
    ]);
  });
});

describe("material notification", () => {
  it("names the material and the meetup", () => {
    const content: RenderableContent = {
      kind: "meetup-material",
      meetup,
      materialTitle: "Правила",
    };
    expect(renderNotification(content).text).toBe(
      "Новое связанное сообщение: Настолки у Лёши\nПравила",
    );
    expect(buttons(content)).toEqual([
      expect.objectContaining({ text: "Открыть сходку" }),
      expect.objectContaining({
        callback_data: "v1:notify:moff:AZjypHwefTqbIU-OEqs0zw:material",
      }),
    ]);
  });

  it("omits an untitled material line", () => {
    expect(
      renderNotification({
        kind: "meetup-material",
        meetup,
        materialTitle: " ",
      }).text,
    ).toBe("Новое связанное сообщение: Настолки у Лёши");
  });
});

describe("unpublished notification", () => {
  // Сходка скрыта: служебное сообщение не должно вести в карточку, которую
  // человек больше не увидит, и повторно открыть её не даёт.
  it("names the meetup without a way to open it", () => {
    const message = renderNotification({ kind: "meetup-unpublished", meetup });
    expect(message.text).toBe(
      "Сходка снята с публикации: Настолки у Лёши\n12.08.2026 19:00",
    );
    expect(message.keyboard).toBeUndefined();
  });
});

it("keeps every disable button within the 64-byte budget", () => {
  for (const category of ["changes", "material"] as const) {
    expect(
      Buffer.byteLength(disableMeetupCategoryCallback(meetupId, category)),
    ).toBeLessThanOrEqual(64);
  }
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

  it("sends a message without buttons without any markup", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    await sender.send({
      telegramUserId: 42n,
      content: { kind: "meetup-unpublished", meetup },
    });
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("reply_markup");
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
