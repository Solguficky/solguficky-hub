import { describe, expect, it } from "vitest";
import {
  parseCallback,
  type QuestionStep,
  questionData,
  traceCallback,
} from "./parse-callback.js";

describe("callback parser", () => {
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
    for (const category of ["reminder", "announcement", "published"]) {
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
    ];
    for (const [data, step] of steps) {
      expect(questionData(step)).toBe(data);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toEqual({ kind: "question", step });
    }
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
