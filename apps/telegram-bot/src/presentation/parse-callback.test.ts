import { describe, expect, it } from "vitest";
import { parseCallback } from "./parse-callback.js";

describe("callback parser", () => {
  it("parses a meetup card action", () => {
    expect(parseCallback("v1:view:AZjypHwefTqbIU-OEqs0zg")).toEqual({
      kind: "view-meetup",
      token: "AZjypHwefTqbIU-OEqs0zg",
    });
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
    const expected = {
      [`v1:manage:publish-later:${token}`]: "manage-publish-later",
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
      [`v1:mm:confirm-add:${meetup}:${material}`, "confirm-attach-material"],
      [`v1:mm:rm:${meetup}:${material}`, "remove-material"],
      [`v1:mm:confirm-rm:${meetup}:${material}`, "confirm-remove-material"],
      [`v1:mm:file:${meetup}:${material}`, "open-material-file"],
    ] as const;
    for (const [data, kind] of cases) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toMatchObject({ kind });
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
    expect(parseCallback(`v1:community:block:${token}`)).toEqual({
      kind: "block-member",
      token,
    });
    expect(parseCallback("v1:community:remove:alice_1")).toEqual({
      kind: "remove-allowed-username",
      username: "alice_1",
    });
    expect(
      Buffer.byteLength(`v1:community:block:${token}`),
    ).toBeLessThanOrEqual(64);
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
      ...["changes", "material", "reminder", "organizer"].map(
        (category) => `v1:notify:set:${token}:${category}:1`,
      ),
    ];
    for (const data of callbacks) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallback(data).kind).not.toBe("malformed");
    }
  });
});
