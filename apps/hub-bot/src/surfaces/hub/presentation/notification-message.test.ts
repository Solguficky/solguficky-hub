import { GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { encodeAuctionCallback } from "../../../auction-ui/index.js";
import { renderFinalNotice } from "../../../core/notifications/final-notice.js";
import {
  createLotNoticeRender,
  type LotNotice,
} from "../../../core/notifications/lot-notice.js";
import type {
  MeetupAspect,
  MeetupLifecycle,
  MeetupWhen,
  NotifiedMeetup,
} from "../delivery/notification.js";
import {
  classifySendFailure,
  createNotificationSender,
  disableAnnouncementCallback,
  disableMeetupCategoryCallback,
  disablePublishedCallback,
  disableReminderCallback,
  type OutgoingNotification,
  renderNotification,
  telegramTextLimit,
} from "./notification-message.js";

const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf";
const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

function content(
  when: MeetupWhen,
  overrides: { title?: string; venue?: string } = {},
): OutgoingNotification {
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
): OutgoingNotification {
  return { kind: "meetup-changed", meetup, aspects, lifecycle, visibility };
}

function buttons(content: OutgoingNotification): unknown[] {
  return (renderNotification(content).keyboard?.inline_keyboard ?? []).flat();
}

// Весть о лоте собирает общий рендер двух ботов, отправитель хаба рисует её
// своими следами (PER-598).
async function lotNotice(notice: LotNotice) {
  const rendered = await createLotNoticeRender({
    reads: { holdsPlaceBids: async () => true, lotTitle: async () => "Кружка" },
    onTitleMissing: () => {},
    frequencyButton: true,
  })(notice, { recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd" });
  if (rendered.kind !== "ready") throw new Error("the notice must render");
  return renderNotification({ kind: "lot-notice", view: rendered.message });
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
  // Анонс финала (PER-478): свой лот — ряд с его названием, след на карточку
  // лота аукционного дерева; у старта финала клавиатуры нет.
  it("traces the own lot of the final lineup and sends the started final bare", () => {
    const view = renderFinalNotice(
      {
        kind: "final-lineup",
        auctionId: "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b",
        lineup: [{ lotId, price: { minorUnits: 50_000, currency: "RUB" } }],
        yourLotIds: [lotId],
      },
      { titles: new Map([[lotId, "Кружка"]]) },
    );
    const lineup = renderNotification({ kind: "lot-notice", view });
    expect(lineup.text.split("\n")[0]).toBe(
      "Твой лот в финале аукциона. Состав финала:",
    );
    expect(lineup.keyboard?.inline_keyboard).toEqual([
      [
        {
          text: "Кружка",
          callback_data: `v1:t:${encodeAuctionCallback({ kind: "lot", lotId, page: 0 }).slice("v1:".length)}`,
        },
      ],
    ]);
    const started = renderNotification({
      kind: "lot-notice",
      view: renderFinalNotice(
        {
          kind: "final-started",
          auctionId: "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b",
        },
        { titles: new Map() },
      ),
    });
    expect(started).toEqual({
      text: "Начался финал аукциона.",
      keyboard: undefined,
    });
  });

  // Итог розыгрыша (PER-620): победителю своя фраза, остальным — номер
  // выигравшего билета и свой; кнопка следа ведёт на экран итога.
  it("tells the winner and the others the raffle result with a traced button", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const result = (ticket: number) =>
      renderNotification({
        kind: "raffle-result",
        auctionId,
        ticket,
        winningTicket: 7,
        ticketCount: 12,
      });

    expect(result(7).text).toBe(
      "Твой билет №7 из 12 выиграл розыгрыш среди участников.",
    );
    expect(result(3).text).toBe(
      "Розыгрыш среди участников проведён: выиграл билет №7 из 12, твой — №3.",
    );
    expect(result(3).keyboard?.inline_keyboard).toEqual([
      [
        {
          text: "К розыгрышу",
          callback_data: `v1:t:${encodeAuctionCallback({ kind: "raffle", auctionId }).slice("v1:".length)}`,
        },
      ],
    ]);
  });

  // Записи 30 и 32 прогона 12.10: участник сообщества видит название лота, как
  // гость в боте аукциона, а под перебитием — «Частота уведомлений» вместо
  // «Реже» (PER-598).
  it("names the lot of an outbid for a community member with traced buttons", async () => {
    const rendered = await lotNotice({
      kind: "lot-outbid",
      lotId,
      currentPrice: { minorUnits: 150_000, currency: "RUB" },
    });

    expect(rendered.text).toBe(
      "Твою ставку на «Кружка» перебили. Текущая цена — 1 500 ₽.",
    );
    const button = rendered.keyboard?.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("К лоту");
    expect(button).toMatchObject({
      callback_data: expect.stringMatching(/^v1:t:auc:lot:/),
    });
    // Частота — одним рядом с «К лоту», след ведёт в её экран под
    // «Расширениями» (PER-605).
    expect(rendered.keyboard?.inline_keyboard).toHaveLength(1);
    expect(rendered.keyboard?.inline_keyboard[0]?.[1]).toEqual({
      text: "Частота уведомлений",
      callback_data: "v1:t:notify:outbid",
    });
  });

  it("puts the frequency under a proxy answer too", async () => {
    const rendered = await lotNotice({
      kind: "lot-proxy-raised",
      lotId,
      currentPrice: { minorUnits: 150_000, currency: "RUB" },
    });
    expect(rendered.keyboard?.inline_keyboard[0]?.[1]?.text).toBe(
      "Частота уведомлений",
    );
  });

  // Запись 37: покупка называет лот и следующий шаг, а частота её не трогает.
  it("keeps a purchase to the lot button alone, with the next step", async () => {
    const rendered = await lotNotice({
      kind: "lot-purchased",
      lotId,
      price: { minorUnits: 150_000, currency: "RUB" },
    });
    expect(rendered.text).toBe(
      "Лот «Кружка» твой за 1 500 ₽. Как оплатить и забрать — напишет организатор аукциона.",
    );
    expect(rendered.keyboard?.inline_keyboard).toEqual([
      [expect.objectContaining({ text: "К лоту" })],
    ]);
  });

  // Сводка (PER-596) — одним сообщением, и каждый лот открывается своей
  // кнопкой следа в пределах 64 байт.
  it("opens every lot of a digest by a traced button", async () => {
    const other = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1";
    const rendered = await lotNotice({
      kind: "lot-activity-digest",
      lines: [
        {
          lotId,
          kind: "outbid",
          currentPrice: { minorUnits: 150_000, currency: "RUB" },
          recipientLeads: false,
        },
        {
          lotId: other,
          kind: "outbid",
          currentPrice: { minorUnits: 90_000, currency: "RUB" },
          recipientLeads: true,
        },
      ],
    });
    expect(rendered.text.split("\n")[0]).toBe("Сводка по твоим ставкам:");
    const rows = rendered.keyboard?.inline_keyboard ?? [];
    expect(rows).toHaveLength(3);
    for (const [index, id] of [lotId, other].entries()) {
      const button = rows[index]?.[0];
      const data =
        button !== undefined && "callback_data" in button
          ? button.callback_data
          : "";
      expect(data).toContain(`v1:t:auc:lot:`);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(data).not.toContain(id === lotId ? other : lotId);
    }
    expect(rows[2]).toEqual([
      { text: "Частота уведомлений", callback_data: "v1:t:notify:outbid" },
    ]);
  });

  it("names the meetup, when and where, with two buttons", () => {
    const message = renderNotification(
      content({
        kind: "day-start",
        tentative: false,
        at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
      }),
    );
    expect(message.text).toBe(
      "Новая сходка: Настолки у Лёши\n📅 Когда: 12 августа, ср, 19:00\n📍 Где: Циферблат",
    );
    const rows = message.keyboard?.inline_keyboard ?? [];
    expect(rows[0]?.[0]).toMatchObject({ text: "Открыть сходку" });
    expect(rows[0]?.[0]).toHaveProperty(
      "callback_data",
      "v1:t:view:AZjypHwefTqbIU-OEqs0zw",
    );
    expect(rows[1]?.[0]).toMatchObject({
      text: "Не присылать новые сходки",
      callback_data: disablePublishedCallback,
    });
  });

  it("does not promise a precision the meetup does not have", () => {
    const text = (when: MeetupWhen) =>
      renderNotification(content(when, { venue: "" })).text.split("\n")[1];
    expect(text({ kind: "no-date" })).toBe("📅 Когда: дата пока не назначена");
    expect(
      text({
        kind: "day",
        tentative: true,
        date: { year: 2026, month: 8, day: 12 },
      }),
    ).toBe("📅 Когда: предварительно 12 августа, ср");
    expect(
      text({
        kind: "interval",
        tentative: false,
        start: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
        end: { year: 2026, month: 8, day: 12, hours: 22, minutes: 30 },
      }),
    ).toBe("📅 Когда: 12 августа, ср, 19:00–22:30");
    expect(
      text({
        kind: "interval",
        tentative: false,
        start: { year: 2026, month: 8, day: 12, hours: 22, minutes: 0 },
        end: { year: 2026, month: 8, day: 13, hours: 2, minutes: 0 },
      }),
    ).toBe("📅 Когда: 12 августа, ср, 22:00–13 августа, чт, 02:00");
  });

  // Прогон 14.10, №60: дата читается, как на карточке, — чужой год назван.
  it("names the year of a meetup outside the current community year", () => {
    const message = renderNotification(
      content({
        kind: "day-start",
        tentative: false,
        at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
      }),
      undefined,
      { year: 2025, month: 12, day: 30 },
    );
    expect(message.text.split("\n")[1]).toBe(
      "📅 Когда: 12 августа 2026, ср, 19:00",
    );
  });

  it("omits an empty venue line", () => {
    const message = renderNotification(
      content({ kind: "no-date" }, { venue: " " }),
    );
    expect(message.text).not.toContain("Где");
  });

  it("keeps the disable button within the 64-byte budget", () => {
    expect(Buffer.byteLength(disablePublishedCallback)).toBeLessThanOrEqual(64);
  });

  // PER-537, RFC-015 С-12: о понижении сообщает прежний бот — хаб, и вручает
  // ссылку на бот аукциона текстом. Клавиатуры у вести нет: вести внутрь хаба
  // некуда, а url-кнопка к чужому боту была бы новым приёмом.
  it("tells the demoted member where the auction moved, with the link in the text", () => {
    const message = renderNotification(
      { kind: "circle-demoted" },
      "solguficky_auction_bot",
    );
    expect(message.text).toBe(
      "Аукцион теперь в боте аукциона: https://t.me/solguficky_auction_bot",
    );
    expect(message.keyboard).toBeUndefined();
  });

  // Имени бота нет — ссылку дать нечем, но о смене круга человеку всё равно
  // сообщают (PER-537).
  it("sends the news without a link when the auction bot name is unknown", () => {
    expect(renderNotification({ kind: "circle-demoted" }).text).toBe(
      "Аукцион теперь в боте аукциона.",
    );
  });
});

describe("reminder notification", () => {
  it("names the meetup, when and where, and offers to stop reminders", () => {
    const message = renderNotification({ kind: "meetup-reminder", meetup });
    expect(message.text).toBe(
      "Напоминание: Настолки у Лёши\n📅 Когда: 12 августа, ср, 19:00\n📍 Где: Циферблат",
    );
    const rows = message.keyboard?.inline_keyboard ?? [];
    expect(rows[0]?.[0]).toMatchObject({
      text: "Открыть сходку",
      callback_data: "v1:t:view:AZjypHwefTqbIU-OEqs0zw",
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
      "Изменения в сходке: Настолки у Лёши\nИзменилось: место, дата и время\n📅 Когда: 12 августа, ср, 19:00\n📍 Где: Циферблат",
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

  // Прогон 14.10, №105: изменений у отменённой сходки не будет — выключать
  // их нечего, под отменой одна «Открыть сходку».
  it("offers only to open a cancelled meetup", () => {
    expect(buttons(changed(["lifecycle"], "cancelled"))).toEqual([
      expect.objectContaining({
        text: "Открыть сходку",
        callback_data: "v1:t:view:AZjypHwefTqbIU-OEqs0zw",
      }),
    ]);
  });

  it("keeps other changes next to the new state", () => {
    expect(
      renderNotification(changed(["lifecycle", "title"], "held")).text,
    ).toBe(
      "Сходка состоялась: Настолки у Лёши\nИзменилось: название\n📅 Когда: 12 августа, ср, 19:00\n📍 Где: Циферблат",
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
        callback_data: "v1:t:view:AZjypHwefTqbIU-OEqs0zw",
      }),
      expect.objectContaining({
        callback_data: "v1:notify:moff:AZjypHwefTqbIU-OEqs0zw:changes",
      }),
    ]);
  });
});

describe("material notification", () => {
  it("names the material and the meetup", () => {
    const content: OutgoingNotification = {
      kind: "meetup-material",
      meetup,
      materialTitle: "Правила",
    };
    expect(renderNotification(content).text).toBe(
      "Новый материал у сходки «Настолки у Лёши»\nПравила",
    );
    expect(buttons(content)).toEqual([
      expect.objectContaining({ text: "Открыть сходку" }),
      expect.objectContaining({
        text: "Не присылать материалы этой сходки",
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
    ).toBe("Новый материал у сходки «Настолки у Лёши»");
  });
});

describe("unpublished notification", () => {
  // Сходка скрыта: служебное сообщение не должно вести в карточку, которую
  // человек больше не увидит, и повторно открыть её не даёт.
  it("names the meetup without a way to open it", () => {
    const message = renderNotification({ kind: "meetup-unpublished", meetup });
    expect(message.text).toBe(
      "Сходка снята с публикации: Настолки у Лёши\n📅 Когда: 12 августа, ср, 19:00",
    );
    expect(message.keyboard).toBeUndefined();
  });
});

describe("organizer message", () => {
  const organizer = (body: string): OutgoingNotification => ({
    kind: "organizer-message",
    meetup,
    body,
  });

  it("puts the author's text under the meetup, verbatim", () => {
    expect(renderNotification(organizer("  Берите\nнастолки  ")).text).toBe(
      "Сообщение организатора: Настолки у Лёши\n\n  Берите\nнастолки  ",
    );
  });

  it("opens the meetup and disables organizer messages for this meetup only", () => {
    expect(buttons(organizer("Берите настолки"))).toEqual([
      expect.objectContaining({ text: "Открыть сходку" }),
      expect.objectContaining({
        text: "Не присылать сообщения организатора",
        callback_data: "v1:notify:moff:AZjypHwefTqbIU-OEqs0zw:organizer",
      }),
    ]);
  });

  // Тело до предела Telegram — законный ввод; заголовок над ним получил бы 400.
  // Тогда уходит одно тело, а сходку называет кнопка.
  const lead = "Сообщение организатора: Настолки у Лёши\n\n";
  const fits = "а".repeat(telegramTextLimit - lead.length);

  it("keeps the headline while it fits the Telegram limit", () => {
    expect(renderNotification(organizer(fits)).text).toBe(`${lead}${fits}`);
  });

  it("sends the bare body with both buttons once the headline does not fit", () => {
    const over = `${fits}б`;
    expect(renderNotification(organizer(over)).text).toBe(over);
    expect(buttons(organizer(over))).toHaveLength(2);
  });
});

describe("access request", () => {
  const stop = expect.objectContaining({
    text: "Не присылать запросы доступа",
    callback_data: "v1:notify:off:access",
  });

  it("names the hub request, leads to its queue and offers to stop requests", () => {
    const content: OutgoingNotification = {
      kind: "access-requested",
      queue: "community",
    };
    expect(renderNotification(content).text).toBe(
      "Новая заявка на доступ в сообщество",
    );
    expect(buttons(content)).toEqual([
      expect.objectContaining({
        text: "Открыть заявки",
        callback_data: "v1:t:cm:q",
      }),
      stop,
    ]);
  });

  // Очередь хаба допускает в участники: аукционную заявку ведут в очередь
  // аукциона, где допуск выдаёт право ставить (PER-534). Категория у обеих
  // очередей одна, и выключатель стоит под обеими.
  it("leads the auction request to the auction queue, not the hub one", () => {
    const content: OutgoingNotification = {
      kind: "access-requested",
      queue: "auction",
    };
    expect(renderNotification(content).text).toBe(
      "Новая заявка на участие в аукционе",
    );
    expect(buttons(content)).toEqual([
      expect.objectContaining({
        text: "Открыть заявки",
        callback_data: "v1:t:aq:q",
      }),
      stop,
    ]);
  });
});

describe("access request with the application", () => {
  const stop = expect.objectContaining({
    text: "Не присылать запросы доступа",
    callback_data: "v1:notify:off:access",
  });
  const applicationId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903";
  const createdAtMs = Date.UTC(2026, 9, 12, 18, 5, 7, 40);

  // Тело заявки — те же строки, что карточка очереди, а решение — те же
  // данные кнопок с пометкой следа: экран исхода придёт новым сообщением.
  it("shows the application with admit and decline of the queue card", () => {
    const content: OutgoingNotification = {
      kind: "access-request-card",
      queue: "community",
      application: {
        applicationId,
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3904",
        telegramUserId: 7110n,
        telegramUsername: "alice_b",
        firstName: "Алиса <3",
        circle: "member",
        source: { kind: "channel", label: "Ярмарка" },
        createdAtMs,
      },
      shownAtMs: createdAtMs + 5 * 60_000,
    };
    const message = renderNotification(content);

    expect(message.format).toBe("HTML");
    expect(message.text).toBe(
      [
        "Новая заявка на доступ в сообщество",
        "",
        "Алиса &lt;3 (@alice_b)",
        "Пришёл: канал «Ярмарка» · 5 минут назад",
      ].join("\n"),
    );
    const data = `AZjypHwefTqbIU-OEqs5Aw:${createdAtMs.toString(36)}`;
    expect(buttons(content)).toEqual([
      expect.objectContaining({ callback_data: `v1:t:cm:qa:${data}` }),
      expect.objectContaining({ callback_data: `v1:t:cm:qd:${data}` }),
      expect.objectContaining({
        text: "Профиль ↗",
        url: "https://t.me/alice_b",
      }),
      stop,
    ]);
  });

  it("names the auction queue in the decision buttons", () => {
    const content: OutgoingNotification = {
      kind: "access-request-card",
      queue: "auction",
      application: {
        applicationId,
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3904",
        telegramUserId: 7110n,
        circle: "public",
        source: { kind: "none" },
        createdAtMs,
      },
      shownAtMs: createdAtMs,
    };
    expect(renderNotification(content).text).toContain(
      "Новая заявка на участие в аукционе",
    );
    expect(
      buttons(content).map(
        (button) => (button as { callback_data?: string }).callback_data,
      ),
    ).toEqual([
      expect.stringMatching(/^v1:t:aq:qa:/),
      expect.stringMatching(/^v1:t:aq:qd:/),
      "v1:notify:off:access",
    ]);
  });

  // Заявку решили до доставки: решать нечего, остальные — в очереди.
  it("says a decided application was decided and leads to the queue", () => {
    const content: OutgoingNotification = {
      kind: "access-request-decided",
      queue: "community",
    };
    const message = renderNotification(content);
    expect(message.text).toBe(
      "Новая заявка на доступ в сообщество\n\nЭту заявку уже решили.",
    );
    expect(message.format).toBeUndefined();
    expect(buttons(content)).toEqual([
      expect.objectContaining({
        text: "Открыть заявки",
        callback_data: "v1:t:cm:q",
      }),
      stop,
    ]);
  });

  it("sends the card as HTML", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({
      sendMessage,
      setMyCommands: vi.fn(),
      deleteMyCommands: vi.fn(),
    } as never);
    await sender.send({
      telegramUserId: 7110n,
      message: {
        kind: "access-request-card",
        queue: "community",
        application: {
          applicationId,
          identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3904",
          telegramUserId: 7110n,
          circle: "member",
          source: { kind: "none" },
          createdAtMs,
        },
        shownAtMs: createdAtMs,
      },
    });
    expect(sendMessage).toHaveBeenCalledWith(
      7110,
      expect.any(String),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });
});

describe("access granted", () => {
  // Прежнее сообщение экрана состава: тот же текст и кнопка следа в корень
  // «Сходки» (решение владельца 10 октября 2026 года).
  it("opens access and leads to the meetups", () => {
    const content: OutgoingNotification = { kind: "access-granted" };
    expect(renderNotification(content).text).toBe(
      "Доступ открыт: теперь тебе видны сходки сообщества.",
    );
    expect(buttons(content)).toEqual([
      expect.objectContaining({
        text: "Сходки",
        callback_data: "v1:t:nav:hub",
      }),
    ]);
  });
});

describe("preset granted", () => {
  // Прогон 14.10, №48: факт не несёт прежних прав, и у мейнтейнера
  // «Управление» было и до набора — текст говорит, что есть, а не что
  // появилось, и ведёт в «Управление».
  it("names the administrator rights and leads to the management by a trace button", () => {
    const content: OutgoingNotification = {
      kind: "preset-granted",
      preset: "admin",
    };
    expect(renderNotification(content).text).toBe(
      "Тебе выданы права администратора сообщества: заявки, состав и сходки. Они собраны в «Управлении» — кнопка ниже или команда /manage.",
    );
    expect(renderNotification(content).text).not.toContain("появил");
    expect(buttons(content)).toEqual([
      expect.objectContaining({
        text: "Управление",
        callback_data: "v1:t:manage:menu",
      }),
    ]);
  });
});

describe("community announcement", () => {
  const announcement = (body: string): OutgoingNotification => ({
    kind: "community-announcement",
    body,
  });

  it("names the announcement and offers to stop announcements, without a meetup", () => {
    const message = renderNotification(announcement("Сбор в пятницу"));
    expect(message.text).toBe("Объявление сообщества\n\nСбор в пятницу");
    expect(buttons(announcement("Сбор в пятницу"))).toEqual([
      expect.objectContaining({
        text: "Не присылать объявления",
        callback_data: disableAnnouncementCallback,
      }),
    ]);
  });

  it("sends a body at the Telegram limit without the headline", () => {
    const limit = "а".repeat(telegramTextLimit);
    expect(renderNotification(announcement(limit)).text).toBe(limit);
  });
});

it("keeps every disable button within the 64-byte budget", () => {
  for (const category of ["changes", "material", "organizer"] as const) {
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
        message: content({ kind: "no-date" }),
      }),
    ).resolves.toEqual({ kind: "sent" });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Новая сходка"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  // PER-468; решение владельца 10 октября 2026 года: «Управление» — команда,
  // и назначенному администратором она встаёт в список команд его чата.
  it("puts /manage into the chat commands of a new administrator", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const sender = createNotificationSender({
      sendMessage,
      setMyCommands,
    } as never);
    await expect(
      sender.send({
        telegramUserId: 42n,
        message: { kind: "preset-granted", preset: "admin" },
      }),
    ).resolves.toEqual({ kind: "sent" });
    expect(setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        { command: "manage", description: "Управление" },
      ]),
      { scope: { type: "chat", chat_id: 42 } },
    );
  });

  it("sends a message without buttons without any markup", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender({ sendMessage } as never);
    await sender.send({
      telegramUserId: 42n,
      message: { kind: "meetup-unpublished", meetup },
    });
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("reply_markup");
  });

  // PER-537: имя бота аукциона отправитель берёт из конфигурации — сама весть о
  // понижении ссылку не несёт.
  it("delivers the demotion with the auction bot link from the config", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = createNotificationSender(
      { sendMessage } as never,
      "solguficky_auction_bot",
    );
    await sender.send({
      telegramUserId: 42n,
      message: { kind: "circle-demoted" },
    });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      "Аукцион теперь в боте аукциона: https://t.me/solguficky_auction_bot",
      expect.objectContaining({ link_preview_options: { is_disabled: true } }),
    );
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
