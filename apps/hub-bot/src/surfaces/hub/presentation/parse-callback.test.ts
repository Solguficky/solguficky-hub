import { describe, expect, it } from "vitest";
import { maxLotRubles } from "../application/lot-form.js";
import {
  auctionFaqData,
  cardCursorData,
  consoleConfirmData,
  consoleDiscardConfirmData,
  consoleDiscardData,
  consoleFinalData,
  consoleMarkData,
  consoleOpenData,
  consoleViewData,
  consoleWeekData,
  lotAskData,
  lotFormData,
  lotNewData,
  parseCallback,
  type QuestionStep,
  questionData,
  traceCallback,
} from "./parse-callback.js";

describe("callback parser", () => {
  it("parses a hub FAQ action with its auction target", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const data = auctionFaqData(token);
    expect(data).toBe(`v1:faq:${token}`);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({
      kind: "auction-faq",
      auction: token,
    });
    expect(parseCallback("v1:faq:short")).toEqual({ kind: "malformed" });
  });

  it("parses a meetup card action", () => {
    expect(parseCallback("v1:view:AZjypHwefTqbIU-OEqs0zg")).toEqual({
      kind: "view-meetup",
      token: "AZjypHwefTqbIU-OEqs0zg",
    });
  });
  it("reads a trace button as the same action marked as a trace", () => {
    expect(parseCallback("v1:t:view:AZLzpLXGfY6fChssPU5fYA")).toEqual({
      kind: "view-meetup",
      token: "AZLzpLXGfY6fChssPU5fYA",
      trace: true,
    });
    expect(parseCallback("v1:t:nav:hub")).toEqual({ kind: "hub", trace: true });
    expect(traceCallback("v1:notify:global")).toBe("v1:t:notify:global");
    expect(parseCallback("v1:t:view:short")).toEqual({ kind: "malformed" });
    expect(
      Buffer.byteLength(
        traceCallback("v1:notify:settings:AZLzpLXGfY6fChssPU5fYA"),
      ),
    ).toBeLessThanOrEqual(64);
  });

  it("parses the page of a list within the byte budget", () => {
    expect(parseCallback("v1:nav:hub:2")).toEqual({ kind: "hub", page: 2 });
    expect(parseCallback("v1:nav:archive:0")).toEqual({
      kind: "archive",
      page: 0,
    });
    expect(parseCallback("v1:manage:hidden:11")).toEqual({
      kind: "manage-hidden",
      page: 11,
    });
    expect(parseCallback("v1:nav:hub")).toEqual({ kind: "hub" });
    expect(parseCallback("v1:nav:hub:-1")).toEqual({ kind: "malformed" });
    expect(parseCallback("v1:nav:hub:вторая")).toEqual({ kind: "malformed" });
  });

  it("parses a declined confirmation of a material and of a broadcast", () => {
    expect(parseCallback("v1:mm:no:AZLzpLXGfY6fChssPU5fYA")).toEqual({
      kind: "decline-attach-material",
      token: "AZLzpLXGfY6fChssPU5fYA",
    });
    expect(parseCallback("v1:bc:no:AZLzpLXGfY6fChssPU5fYA")).toEqual({
      kind: "cancel-broadcast",
      token: "AZLzpLXGfY6fChssPU5fYA",
    });
    expect(parseCallback("v1:bc:no")).toEqual({ kind: "cancel-broadcast" });
  });

  it("distinguishes outdated and malformed callbacks", () => {
    expect(parseCallback("v2:manage:menu")).toEqual({ kind: "outdated" });
    expect(parseCallback("v1:manage:new:not-a-token")).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(42)).toEqual({ kind: "malformed" });
  });

  it("parses a create action within the Telegram byte budget", () => {
    const data = "v1:manage:new:AZLzpLXGfY6fChssPU5fYA";
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({
      kind: "create-meetup",
      token: "AZLzpLXGfY6fChssPU5fYA",
    });
  });

  it("parses the hidden meetups section of management", () => {
    expect(parseCallback("v1:manage:hidden")).toEqual({
      kind: "manage-hidden",
    });
  });

  it("parses the home, hub and archive navigation actions", () => {
    expect(parseCallback("v1:nav:start")).toEqual({ kind: "home" });
    expect(parseCallback("v1:nav:hub")).toEqual({ kind: "hub" });
    expect(parseCallback("v1:nav:archive")).toEqual({ kind: "archive" });
  });

  it("parses meetup editing and confirmed state actions within the byte budget", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const callbacks = [
      `v1:manage:edit:${token}`,
      `v1:manage:field:${token}:description`,
      `v1:manage:status:${token}`,
      `v1:manage:republish:${token}`,
      `v1:manage:unpublish:${token}`,
      `v1:manage:confirm-unpublish:${token}`,
      `v1:manage:cancel:${token}`,
      `v1:manage:confirm-cancel:${token}`,
      `v1:manage:hold:${token}`,
      `v1:manage:confirm-hold:${token}`,
    ];

    for (const callback of callbacks) {
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    }

    expect(parseCallback(callbacks[0])).toEqual({ kind: "manage-edit", token });
    expect(parseCallback(callbacks[1])).toEqual({
      kind: "manage-field",
      token,
      field: "description",
    });
    expect(parseCallback(callbacks[2])).toEqual({
      kind: "manage-status",
      token,
    });
    expect(parseCallback(callbacks[3])).toEqual({
      kind: "manage-publish",
      token,
    });
    expect(parseCallback(callbacks[4])).toEqual({
      kind: "manage-unpublish",
      token,
    });
    expect(parseCallback(callbacks[5])).toEqual({
      kind: "manage-confirm-unpublish",
      token,
    });
    expect(parseCallback(callbacks[6])).toEqual({
      kind: "manage-cancel",
      token,
    });
    expect(parseCallback(callbacks[7])).toEqual({
      kind: "manage-confirm-cancel",
      token,
    });
    expect(parseCallback(callbacks[8])).toEqual({
      kind: "manage-hold",
      token,
    });
    expect(parseCallback(callbacks[9])).toEqual({
      kind: "manage-confirm-hold",
      token,
    });
  });

  // «Да» несёт версию сходки, которую человек видел (PER-472): самая длинная
  // строка — `confirm-unschedule` с девятью цифрами, она в пределе 64 байт.
  it("parses the version of a state confirmation within the byte budget", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    for (const action of [
      "unpublish",
      "cancel",
      "hold",
      "unschedule",
    ] as const) {
      const callback = `v1:manage:confirm-${action}:${token}:999999999`;
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
      expect(parseCallback(callback)).toEqual({
        kind: `manage-confirm-${action}`,
        token,
        version: 999999999,
      });
    }
    for (const version of ["0", "01", "x", "1234567890"]) {
      expect(
        parseCallback(`v1:manage:confirm-cancel:${token}:${version}`),
      ).toEqual({ kind: "malformed" });
    }
    expect(parseCallback(`v1:manage:confirm-cancel:${token}:1:2`)).toEqual({
      kind: "malformed",
    });
  });

  it("parses deferred publication actions within the byte budget", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    // Кнопка черновика несёт источник: «Отмена» под вопросом вернёт на него.
    for (const [callback, origin] of [
      [`v1:manage:publish-later:${token}`, "status"],
      [`v1:manage:publish-later:${token}:d`, "draft"],
    ] as const) {
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
      expect(parseCallback(callback)).toEqual({
        kind: "manage-publish-later",
        token,
        origin,
      });
    }
    expect(parseCallback(`v1:manage:publish-later:${token}:s`)).toEqual({
      kind: "malformed",
    });
    const expected = {
      [`v1:manage:unschedule:${token}`]: "manage-unschedule",
      [`v1:manage:confirm-unschedule:${token}`]: "manage-confirm-unschedule",
    };

    for (const [callback, kind] of Object.entries(expected)) {
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
      expect(parseCallback(callback)).toEqual({ kind, token });
    }
    expect(parseCallback(`v1:manage:unschedule:${token}:1`)).toEqual({
      kind: "malformed",
    });
  });

  it("parses material actions within the callback byte budget", () => {
    const meetup = "AZLzpLXGfY6fChssPU5fYA";
    const material = "AZnA3gAAAAAAAABfP4Lqmw";
    const cases = [
      [`v1:mm:list:${meetup}`, "manage-materials"],
      [`v1:mm:add:${meetup}`, "begin-attach-material"],
      [`v1:mm:ca:${meetup}:${material}:999999999`, "confirm-attach-material"],
      [`v1:mm:rm:${meetup}:${material}`, "remove-material"],
      [`v1:mm:cr:${meetup}:${material}:999999999`, "confirm-remove-material"],
      [`v1:mm:file:${meetup}:${material}`, "open-material-file"],
    ] as const;
    for (const [data, kind] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toMatchObject({ kind });
    }
  });

  it("carries the shown meetup version in material confirmations", () => {
    const meetup = "AZLzpLXGfY6fChssPU5fYA";
    const material = "AZnA3gAAAAAAAABfP4Lqmw";
    expect(parseCallback(`v1:mm:ca:${meetup}:${material}:12`)).toEqual({
      kind: "confirm-attach-material",
      token: meetup,
      materialToken: material,
      version: 12,
    });
    expect(parseCallback(`v1:mm:cr:${meetup}:${material}:3`)).toMatchObject({
      kind: "confirm-remove-material",
      version: 3,
    });
    // Кнопка прошлого релиза разбирается без версии, а не с нулевой: команду по
    // ней экран не отправляет.
    expect(parseCallback(`v1:mm:confirm-add:${meetup}:${material}`)).toEqual({
      kind: "confirm-attach-material",
      token: meetup,
      materialToken: material,
    });
    expect(parseCallback(`v1:mm:confirm-rm:${meetup}:${material}`)).toEqual({
      kind: "confirm-remove-material",
      token: meetup,
      materialToken: material,
    });
    for (const data of [
      `v1:mm:ca:${meetup}:${material}`,
      `v1:mm:ca:${meetup}:${material}:0`,
      `v1:mm:cr:${meetup}:${material}:07`,
      `v1:mm:cr:${meetup}:${material}:x`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });

  it("parses a material list page", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback(`v1:mm:list:${token}:3`)).toEqual({
      kind: "manage-materials",
      token,
      page: 3,
    });
  });

  it("parses community administration actions within the byte budget", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback("v1:community:list")).toEqual({ kind: "community" });
    expect(parseCallback("v1:community:allow")).toEqual({
      kind: "ask-allowed-username",
    });
    expect(parseCallback(`v1:community:admit:${token}`)).toEqual({
      kind: "admit-member",
      token,
    });
    // Кнопка прошлого релиза закрывала доступ сразу; теперь она спрашивает.
    expect(parseCallback(`v1:community:block:${token}`)).toEqual({
      kind: "ask-block-member",
      token,
      origin: { kind: "admitted", page: 0 },
    });
    expect(parseCallback("v1:community:remove:alice_1")).toEqual({
      kind: "remove-allowed-username",
      username: "alice_1",
      page: 0,
    });
  });

  it("parses the community lists, the queue cursor and both people of a decision", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const next = "AZKbflwdej-OSy1snwobPA";
    const cases: readonly (readonly [string, unknown])[] = [
      ["v1:cm:p", { kind: "community-pending" }],
      [`v1:cm:p:${next}`, { kind: "community-pending", cursor: next }],
      ["v1:cm:a", { kind: "community-admitted", page: 0 }],
      ["v1:cm:a:12", { kind: "community-admitted", page: 12 }],
      ["v1:cm:u", { kind: "community-usernames", page: 0 }],
      ["v1:cm:u:3", { kind: "community-usernames", page: 3 }],
      [`v1:cm:ad:${token}`, { kind: "admit-member", token }],
      [`v1:cm:ad:${token}:${next}`, { kind: "admit-member", token, next }],
      [
        "v1:cm:r",
        { kind: "refused-applications", queue: "community", page: 0 },
      ],
      ["v1:sc:l", { kind: "source-channels", page: 0 }],
      ["v1:sc:l:4", { kind: "source-channels", page: 4 }],
      ["v1:sc:a", { kind: "ask-source-channel" }],
      [
        "v1:cm:r:2",
        { kind: "refused-applications", queue: "community", page: 2 },
      ],
      [
        `v1:cm:rq:${token}:2`,
        { kind: "ask-reconsider", queue: "community", token, page: 2 },
      ],
      [
        `v1:cm:ry:${token}:9999`,
        { kind: "reconsider", queue: "community", token, page: 9999 },
      ],
      ["v1:aq:r", { kind: "refused-applications", queue: "auction", page: 0 }],
      [
        `v1:aq:rq:${token}:2`,
        { kind: "ask-reconsider", queue: "auction", token, page: 2 },
      ],
      [
        `v1:aq:ry:${token}:9999`,
        { kind: "reconsider", queue: "auction", token, page: 9999 },
      ],
      ["v1:cm:m", { kind: "auction-moderators" }],
      ["v1:cm:mc:3", { kind: "moderator-candidates", page: 3 }],
      [`v1:cm:mg:${token}:3`, { kind: "grant-moderation", token, page: 3 }],
      [`v1:cm:mv:${token}`, { kind: "revoke-moderation", token }],
      [
        `v1:cm:bq:${token}:p`,
        { kind: "ask-block-member", token, origin: { kind: "pending" } },
      ],
      [
        `v1:cm:bq:${token}:p${next}`,
        { kind: "ask-block-member", token, origin: { kind: "pending", next } },
      ],
      [
        `v1:cm:by:${token}:p${next}`,
        { kind: "block-member", token, origin: { kind: "pending", next } },
      ],
      [
        `v1:cm:by:${token}:a9999`,
        {
          kind: "block-member",
          token,
          origin: { kind: "admitted", page: 9999 },
        },
      ],
      [
        `v1:cm:rm:9999:${"a".repeat(32)}`,
        {
          kind: "remove-allowed-username",
          username: "a".repeat(32),
          page: 9999,
        },
      ],
    ];
    for (const [data, action] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual(action);
    }
  });

  it("rejects community callbacks with a broken token, page or shape", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    for (const data of [
      "v1:cm",
      "v1:cm:x",
      "v1:cm:p:short",
      `v1:cm:p:${token}:extra`,
      "v1:cm:a:",
      "v1:cm:a:1e2",
      "v1:cm:a:-1",
      "v1:cm:u:12345",
      "v1:cm:ad",
      `v1:cm:ad:${token}:short`,
      `v1:cm:bq:${token}`,
      `v1:cm:bq:${token}:x`,
      `v1:cm:bq:${token}:pshort`,
      `v1:cm:by:${token}:a`,
      "v1:cm:rm:0",
      "v1:cm:rm:x:alice",
      "v1:cm:rm:0:al-ice",
      `v1:cm:ad:${token}:${token}:extra`,
      `v1:cm:r:${token}`,
      `v1:cm:rq:${token}`,
      `v1:cm:rq:short:0`,
      `v1:cm:ry:${token}:x`,
      `v1:cm:ry:${token}:0:extra`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });

  it("parses the application card cursor of every card action", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const cursor = {
      token,
      createdAtMs: Date.parse("2026-10-02T11:05:00.123Z"),
    };
    const data = cardCursorData(cursor);
    // Очередь называет домен: `cm` — сообщество, `aq` — аукцион.
    const cases = (["community", "auction"] as const).flatMap((queue) => {
      const domain = queue === "community" ? "v1:cm" : "v1:aq";
      return [
        [`${domain}:q`, { kind: "application-card", queue }],
        [
          `${domain}:q:${data}`,
          { kind: "application-card", queue, cursor, from: "after" },
        ],
        [
          `${domain}:qc:${data}`,
          { kind: "application-card", queue, cursor, from: "at" },
        ],
        [`${domain}:qa:${data}`, { kind: "admit-application", queue, cursor }],
        [
          `${domain}:qd:${data}`,
          { kind: "ask-decline-application", queue, cursor },
        ],
        [
          `${domain}:qy:${data}`,
          { kind: "decline-application", queue, cursor },
        ],
      ] as const;
    });
    for (const [raw, action] of cases) {
      // С префиксом трассировки данные длиннее на два байта.
      expect(Buffer.byteLength(traceCallback(raw))).toBeLessThanOrEqual(64);
      expect(parseCallback(raw)).toEqual(action);
    }
  });

  it("rejects application card callbacks with a broken cursor", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    for (const data of [
      "v1:cm:qc",
      "v1:aq:qc",
      `v1:aq:ad:${token}`,
      "v1:aq:m",
      `v1:cm:q:${token}`,
      `v1:cm:qa:${token}`,
      `v1:cm:qa:short:mfz0`,
      `v1:cm:qd:${token}:MFZ0`,
      `v1:cm:qy:${token}:-1`,
      `v1:cm:qy:${token}:${"z".repeat(11)}`,
      `v1:cm:qa:${token}:mfz0:extra`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });
});

describe("past meetup date callbacks", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";

  it("carries the confirmed date back in the typed form, within the byte budget", () => {
    const data = `v1:manage:past:${token}:e:210920261930`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({
      kind: "manage-confirm-past-schedule",
      token,
      editing: true,
      value: "21.09.2026 19:30",
    });
    expect(parseCallback(`v1:manage:past:${token}:c:210920261930`)).toEqual({
      kind: "manage-confirm-past-schedule",
      token,
      editing: false,
      value: "21.09.2026 19:30",
    });
  });

  it("parses the retry within the form mode it came from", () => {
    expect(parseCallback(`v1:manage:past-retry:${token}:c`)).toEqual({
      kind: "manage-retry-past-schedule",
      token,
      editing: false,
    });
  });

  it("refuses a mangled date or mode", () => {
    for (const data of [
      `v1:manage:past:${token}:e:2109202619`,
      `v1:manage:past:${token}:x:210920261930`,
      `v1:manage:past:${token}:e:21.09.2026`,
      `v1:manage:past-retry:${token}:x`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });
});

describe("notification callbacks", () => {
  const token = "AZLzpLXGfY6fChssPU5fYA";

  it("parses the global settings frame and its toggles", () => {
    expect(parseCallback("v1:notify:global")).toEqual({
      kind: "notify-global",
    });
    expect(parseCallback("v1:notify:gset:announcement:1")).toEqual({
      kind: "notify-set-global",
      category: "announcement",
      enabled: true,
    });
    expect(parseCallback("v1:notify:gset:published:0")).toEqual({
      kind: "notify-set-global",
      category: "published",
      enabled: false,
    });
    expect(parseCallback("v1:notify:gset:access:1")).toEqual({
      kind: "notify-set-global",
      category: "access",
      enabled: true,
    });
  });

  it("parses disabling a category from a notification", () => {
    expect(parseCallback("v1:notify:off:published")).toEqual({
      kind: "notify-disable-global",
      category: "published",
    });
    expect(parseCallback("v1:notify:off:reminder")).toEqual({
      kind: "notify-disable-global",
      category: "reminder",
    });
    expect(parseCallback("v1:notify:off:announcement")).toEqual({
      kind: "notify-disable-global",
      category: "announcement",
    });
    expect(parseCallback("v1:notify:off:access")).toEqual({
      kind: "notify-disable-global",
      category: "access",
    });
    expect(parseCallback("v1:notify:off:unknown")).toEqual({
      kind: "malformed",
    });
    expect(parseCallback("v1:notify:off:published:0")).toEqual({
      kind: "malformed",
    });
  });

  it("parses disabling a category of one meetup from a notification", () => {
    expect(parseCallback(`v1:notify:moff:${token}:changes`)).toEqual({
      kind: "notify-disable-meetup",
      token,
      category: "changes",
    });
    expect(parseCallback(`v1:notify:moff:${token}:material`)).toEqual({
      kind: "notify-disable-meetup",
      token,
      category: "material",
    });
    expect(parseCallback(`v1:notify:moff:${token}:organizer`)).toEqual({
      kind: "notify-disable-meetup",
      token,
      category: "organizer",
    });
    // Категорий, о которых уведомления по сходке не приходит, кнопка не несёт.
    for (const category of [
      "reminder",
      "announcement",
      "published",
      "access",
    ]) {
      expect(parseCallback(`v1:notify:moff:${token}:${category}`)).toEqual({
        kind: "malformed",
      });
    }
    expect(parseCallback(`v1:notify:moff:${token}:changes:0`)).toEqual({
      kind: "malformed",
    });
  });

  it("parses meetup notification actions matching the brief", () => {
    expect(parseCallback(`v1:notify:settings:${token}`)).toEqual({
      kind: "notify-settings",
      token,
    });
    expect(parseCallback(`v1:notify:set:${token}:changes:1`)).toEqual({
      kind: "notify-set-meetup",
      token,
      category: "changes",
      enabled: true,
    });
    expect(parseCallback(`v1:notify:sub:${token}:0`)).toEqual({
      kind: "notify-subscription",
      token,
      subscribed: false,
    });
  });

  // Категория, настраиваемая только глобально, у сходки не разбирается вовсе:
  // до `INVALID_ARGUMENT` от Notifications такая кнопка не доезжает.
  it("refuses a global-only category in the meetup scope", () => {
    expect(parseCallback(`v1:notify:set:${token}:published:1`)).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(`v1:notify:set:${token}:announcement:1`)).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(`v1:notify:set:${token}:access:1`)).toEqual({
      kind: "malformed",
    });
  });

  it("refuses malformed notification callbacks", () => {
    expect(parseCallback(`v1:notify:set:${token}:changes:2`)).toEqual({
      kind: "malformed",
    });
    expect(parseCallback("v1:notify:set:not-a-token:changes:1")).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(`v1:notify:sub:${token}:yes`)).toEqual({
      kind: "malformed",
    });
    expect(parseCallback("v1:notify:gset:unknown:1")).toEqual({
      kind: "malformed",
    });
    expect(parseCallback(`v1:notify:unknown:${token}`)).toEqual({
      kind: "malformed",
    });
  });

  // Проверяется самая длинная комбинация, а не литерал из брифа: лимит ломает
  // та категория, которой в таблице примеров нет.
  it("keeps every notification callback within the Telegram byte budget", () => {
    const categories = [
      "published",
      "changes",
      "material",
      "reminder",
      "organizer",
      "announcement",
    ];
    const callbacks = [
      "v1:notify:global",
      `v1:notify:settings:${token}`,
      `v1:notify:sub:${token}:1`,
      ...categories.map((category) => `v1:notify:gset:${category}:1`),
      ...categories.map((category) => `v1:notify:off:${category}`),
      ...["changes", "material", "reminder", "organizer"].map(
        (category) => `v1:notify:set:${token}:${category}:1`,
      ),
      ...["changes", "material", "organizer"].map(
        (category) => `v1:notify:moff:${token}:${category}`,
      ),
    ];
    for (const data of callbacks) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data).kind).not.toBe("malformed");
    }
  });

  it("parses the broadcast entries, confirmations and cancel within the byte budget", () => {
    const meetup = "AZLzpLXGfY6fChssPU5fYA";
    const broadcast = "AZjypHwefTqbIU-OEqs0zg";
    const cases = [
      [`v1:bc:m:${meetup}`, { kind: "begin-meetup-broadcast", token: meetup }],
      ["v1:bc:c", { kind: "begin-community-broadcast" }],
      [
        `v1:bc:ms:${meetup}:${broadcast}`,
        {
          kind: "confirm-meetup-broadcast",
          token: meetup,
          broadcastToken: broadcast,
        },
      ],
      [
        `v1:bc:cs:${broadcast}`,
        { kind: "confirm-community-broadcast", broadcastToken: broadcast },
      ],
      ["v1:bc:no", { kind: "cancel-broadcast" }],
    ] as const;
    for (const [data, expected] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual(expected);
    }
  });

  it("carries the step of a question in its cancel button and reads it back", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const steps: readonly (readonly [string, QuestionStep])[] = [
      [
        `v1:q:fe:${token}:description`,
        { kind: "field", mode: "edit", token, field: "description" },
      ],
      [
        `v1:q:fc:${token}:title`,
        { kind: "field", mode: "create", token, field: "title" },
      ],
      [`v1:q:pm:${token}`, { kind: "publish-moment", token, origin: "status" }],
      [`v1:q:pd:${token}`, { kind: "publish-moment", token, origin: "draft" }],
      [
        `v1:q:ms:${token}:999999999`,
        { kind: "material-source", token, version: 999999999 },
      ],
      [`v1:q:mt:${token}`, { kind: "material-title", token }],
      [`v1:q:bm:${token}`, { kind: "broadcast", token }],
      ["v1:q:bc", { kind: "broadcast" }],
      ["v1:q:nick", { kind: "username" }],
      ["v1:q:cc", { kind: "channel-code" }],
      ["v1:q:cl", { kind: "channel-label" }],
    ];
    // Самый длинный Telegram id — 16 цифр: id укладывается в 52 бита.
    const askedBy = 9007199254740991;
    for (const [data, step] of steps) {
      const asked = `${data}:${askedBy}`;
      expect(questionData(step, askedBy)).toBe(asked);
      expect(Buffer.byteLength(asked)).toBeLessThanOrEqual(64);
      expect(parseCallback(asked)).toEqual({ kind: "question", step, askedBy });
      // Кнопка прошлого релиза id не несёт: шаг читается, а спрашиваемого нет.
      expect(parseCallback(data)).toEqual({ kind: "question", step });
    }
  });

  it("does not take a material version of the previous release for the asked id", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback(`v1:q:ms:${token}:3`)).toEqual({
      kind: "question",
      step: { kind: "material-source", token, version: 3 },
    });
    expect(parseCallback(`v1:q:ms:${token}:3:42`)).toEqual({
      kind: "question",
      step: { kind: "material-source", token, version: 3 },
      askedBy: 42,
    });
    expect(parseCallback(`v1:q:fe:${token}:venue:0`)).toEqual({
      kind: "question",
      step: { kind: "field", mode: "edit", token, field: "venue" },
      askedBy: 0,
    });
    expect(parseCallback(`v1:q:fe:${token}:venue:01`)).toEqual({
      kind: "malformed",
    });
  });

  it("parses the date presets: the day list, a chosen day and a chosen moment", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback(`v1:manage:when:${token}:c`)).toEqual({
      kind: "manage-pick-day",
      token,
      mode: "c",
    });
    expect(parseCallback(`v1:manage:when:${token}:e:03102026`)).toEqual({
      kind: "manage-pick-day",
      token,
      mode: "e",
      picked: { digits: "03102026", day: { year: 2026, month: 10, day: 3 } },
    });
    // Момент публикации выбирается теми же кнопками в режимах `p` и `d`.
    for (const mode of ["c", "e", "p", "d"] as const) {
      const moment = `v1:manage:when:${token}:${mode}:031020261930`;
      expect(Buffer.byteLength(moment)).toBeLessThanOrEqual(64);
      expect(parseCallback(moment)).toEqual({
        kind: "manage-pick-schedule",
        token,
        mode,
        value: "03.10.2026 19:30",
      });
    }
  });

  it("asks for another date by text and cancels back to the screen the date was opened from", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback(`v1:manage:when:${token}:d:t`)).toEqual({
      kind: "manage-type-schedule",
      token,
      mode: "d",
    });
    expect(parseCallback(`v1:manage:when:${token}:c:x`)).toEqual({
      kind: "manage-draft",
      token,
    });
    expect(parseCallback(`v1:manage:when:${token}:d:x`)).toEqual({
      kind: "manage-draft",
      token,
    });
    expect(parseCallback(`v1:manage:when:${token}:e:x`)).toEqual({
      kind: "view-meetup",
      token,
    });
    expect(parseCallback(`v1:manage:when:${token}:p:x`)).toEqual({
      kind: "manage-status",
      token,
    });
  });

  it("rejects a date preset with a broken mode, day or length", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    for (const data of [
      `v1:manage:when:${token}`,
      `v1:manage:when:${token}:x`,
      `v1:manage:when:${token}:q:t`,
      `v1:manage:when:${token}:c:y`,
      `v1:manage:when:${token}:c:31022026`,
      `v1:manage:when:${token}:c:0310202`,
      `v1:manage:when:${token}:c:0310202619`,
      `v1:manage:when:${token}:c:3102202619300`,
      `v1:manage:when:${token}:c:03102026:1930`,
      "v1:manage:when:short:c:03102026",
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });

  it("parses the draft screen and its field buttons", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    expect(parseCallback(`v1:manage:draft:${token}`)).toEqual({
      kind: "manage-draft",
      token,
    });
    expect(parseCallback(`v1:manage:draft:${token}:description`)).toEqual({
      kind: "manage-draft",
      token,
      field: "description",
    });
    expect(
      Buffer.byteLength(`v1:manage:draft:${token}:description`),
    ).toBeLessThanOrEqual(64);
    expect(parseCallback(`v1:manage:draft:${token}:unknown`)).toEqual({
      kind: "malformed",
    });
    expect(parseCallback("v1:manage:draft:short")).toEqual({
      kind: "malformed",
    });
  });

  it("rejects a question step with a broken token, field or shape", () => {
    for (const data of [
      "v1:q",
      "v1:q:fe",
      "v1:q:fe:short:venue",
      "v1:q:fe:AZLzpLXGfY6fChssPU5fYA:unknown",
      "v1:q:fx:AZLzpLXGfY6fChssPU5fYA:venue",
      "v1:q:ms:AZLzpLXGfY6fChssPU5fYA",
      "v1:q:ms:AZLzpLXGfY6fChssPU5fYA:x",
      "v1:q:pm:AZLzpLXGfY6fChssPU5fYA:extra",
      "v1:q:bc:AZLzpLXGfY6fChssPU5fYA",
      "v1:q:nick:extra",
      "v1:q:cc:extra",
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });

  it("rejects broadcast callbacks with a broken token or shape", () => {
    for (const data of [
      "v1:bc:m:short",
      "v1:bc:ms:AZLzpLXGfY6fChssPU5fYA",
      "v1:bc:ms:AZLzpLXGfY6fChssPU5fYA:short",
      "v1:bc:cs:AZLzpLXGfY6fChssPU5fYA:extra",
      "v1:bc:send",
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });
});

// Форма лота (PER-319): кнопки домена `lot` и шаги её вопросов.
describe("lot form callbacks", () => {
  // Худший случай длины: все символы токена занимают по байту, а цена — семь
  // цифр.
  const auction = "2u8Fx81oUEiwPctIYOjccw";
  const lot = "AZKbflwdej-OSy1snwobPA";
  // Ключ создания лота — первые двенадцать символов токена.
  const key = "AZKbflwdej-O";

  it("parses the entries into the form and the rows of its screen within the byte budget", () => {
    const cases = [
      [lotNewData(auction), { kind: "lot-new", auction }],
      [lotFormData(lot), { kind: "lot-form", lot }],
      [lotAskData(lot, "title"), { kind: "lot-ask", lot, field: "title" }],
      [
        lotAskData(lot, "description"),
        { kind: "lot-ask", lot, field: "description" },
      ],
      [lotAskData(lot, "price"), { kind: "lot-ask", lot, field: "price" }],
    ] as const;
    for (const [data, expected] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual(expected);
    }
  });

  it("carries the step of every lot question in its cancel button and reads it back", () => {
    const steps: readonly (readonly [string, QuestionStep])[] = [
      [`v1:q:ln:${auction}:${key}`, { kind: "lot-new", auction, key }],
      [`v1:q:lt:${lot}`, { kind: "lot-text", lot, field: "title" }],
      [`v1:q:ld:${lot}`, { kind: "lot-text", lot, field: "description" }],
      [`v1:q:lp:${lot}`, { kind: "lot-price", lot }],
      // Наибольшая цена, которую принимает разбор ответа, помещается в кнопку.
      [
        `v1:q:ls:${lot}:${maxLotRubles}`,
        { kind: "lot-step", lot, price: maxLotRubles },
      ],
      [`v1:q:ls:${lot}:1`, { kind: "lot-step", lot, price: 1 }],
    ];
    // Самый длинный Telegram id — 16 цифр; с ним шаг обязан уложиться в кнопку.
    const askedBy = 9007199254740991;
    for (const [data, step] of steps) {
      const asked = `${data}:${askedBy}`;
      expect(questionData(step, askedBy)).toBe(asked);
      expect(Buffer.byteLength(asked)).toBeLessThanOrEqual(64);
      expect(parseCallback(asked)).toEqual({ kind: "question", step, askedBy });
    }
  });

  it("rejects a lot callback with a broken token, field, price or shape", () => {
    for (const data of [
      "v1:lot",
      "v1:lot:new",
      "v1:lot:new:short",
      `v1:lot:new:${auction}:extra`,
      `v1:lot:form:${lot}:extra`,
      `v1:lot:ask:${lot}`,
      `v1:lot:ask:${lot}:step`,
      `v1:lot:drop:${lot}`,
      `v1:q:ln:${auction}`,
      `v1:q:ln:${auction}:short`,
      `v1:q:ln:${auction}:${lot}`,
      `v1:q:lt:${lot}:extra`,
      `v1:q:lp:${lot}:extra`,
      `v1:q:ls:${lot}`,
      `v1:q:ls:${lot}:0`,
      `v1:q:ls:${lot}:015`,
      `v1:q:ls:${lot}:${maxLotRubles + 1}`,
      `v1:q:ls:${lot}:1e3`,
      `v1:q:ls:${lot}:-5`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });
});

describe("auction console callbacks", () => {
  // Худший случай длины: токены по байту на символ, страница — четыре цифры.
  const auction = "2u8Fx81oUEiwPctIYOjccw";
  const lot = "AZKbflwdej-OSy1snwobPA";
  const op = "AZnypHwefTqbIU-OEqs0qg";
  const defaultSort = { metric: "bids", direction: "descending" };

  it("parses every button of the console within the byte budget", () => {
    const cases = [
      [
        consoleViewData(auction),
        { kind: "console-view", auction, page: 0, sort: defaultSort },
      ],
      [
        consoleViewData(auction, 3),
        { kind: "console-view", auction, page: 3, sort: defaultSort },
      ],
      [
        consoleViewData(auction, 3, {
          metric: "growth",
          direction: "ascending",
        }),
        {
          kind: "console-view",
          auction,
          page: 3,
          sort: { metric: "growth", direction: "ascending" },
        },
      ],
      [consoleWeekData(auction), { kind: "console-week", auction }],
      [
        consoleFinalData(auction, false),
        { kind: "console-final", auction, final: false },
      ],
      [
        consoleFinalData(auction, true),
        { kind: "console-final", auction, final: true },
      ],
      [consoleOpenData(auction), { kind: "console-open", auction }],
      [
        consoleConfirmData(auction, op),
        { kind: "console-confirm", auction, op },
      ],
      [consoleDiscardData(auction), { kind: "console-discard", auction }],
      [
        consoleDiscardConfirmData(auction, op),
        { kind: "console-discard-confirm", auction, op },
      ],
      [
        consoleMarkData({ auction, lot, selected: true, page: 9999 }),
        {
          kind: "console-mark",
          auction,
          lot,
          selected: true,
          page: 9999,
          sort: defaultSort,
        },
      ],
      [
        consoleMarkData({ auction, lot, selected: false, page: 0 }),
        {
          kind: "console-mark",
          auction,
          lot,
          selected: false,
          page: 0,
          sort: defaultSort,
        },
      ],
      [
        consoleMarkData({
          auction,
          lot,
          selected: true,
          page: 9999,
          sort: { metric: "growth", direction: "ascending" },
        }),
        {
          kind: "console-mark",
          auction,
          lot,
          selected: true,
          page: 9999,
          sort: { metric: "growth", direction: "ascending" },
        },
      ],
    ] as const;
    for (const [data, expected] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual(expected);
    }
  });

  it("carries the auction of the week question in its cancel button", () => {
    const askedBy = 9007199254740991;
    const step: QuestionStep = { kind: "console-week", auction };
    const asked = `v1:q:aw:${auction}:${askedBy}`;
    expect(questionData(step, askedBy)).toBe(asked);
    expect(Buffer.byteLength(asked)).toBeLessThanOrEqual(64);
    expect(parseCallback(asked)).toEqual({ kind: "question", step, askedBy });
  });

  it("rejects a console callback with a broken token, state or shape", () => {
    for (const data of [
      "v1:ac:v",
      "v1:ac:v:short",
      `v1:ac:v:${auction}:x`,
      `v1:ac:w:${auction}:1`,
      `v1:ac:f:${auction}`,
      `v1:ac:f:${auction}:2`,
      `v1:ac:o:${auction}:1`,
      `v1:ac:y:${auction}`,
      `v1:ac:y:${auction}:short`,
      `v1:ac:s:${auction}:${lot}`,
      `v1:ac:d:${auction}:${lot}:-1`,
      `v1:ac:x:${auction}:1`,
      `v1:ac:z:${auction}`,
      `v1:ac:z:${auction}:short`,
      `v1:ac:q:${auction}`,
    ]) {
      expect(parseCallback(data)).toEqual({ kind: "malformed" });
    }
  });
});
