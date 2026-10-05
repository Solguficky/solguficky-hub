import type { RoleRequestOutcome } from "@solguficky/auction-bot-ui";
import { describe, expect, it } from "vitest";
import type { HubAccess } from "../application/hub-access.js";
import type { DeepLink } from "../application/types.js";
import { decideHubEntry, hubRoleRequest } from "./hub-entry.js";

const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const person = { telegramUserId: 42n, firstName: "Сова" };

describe("hubRoleRequest", () => {
  it("requests the member circle with the first name", () => {
    expect(
      hubRoleRequest({ ...person, telegramUsername: "owl" }, undefined),
    ).toEqual({
      telegramUserId: 42n,
      telegramUsername: "owl",
      requestedRole: "member",
      firstName: "Сова",
    });
  });

  // Присутствие кода значимо: пустой код после `s_` — «неизвестный источник»,
  // а ссылка на сходку и чужой payload кода не несут вовсе.
  it.each<[DeepLink, { sourceCode?: string }]>([
    [{ kind: "source", code: "tg_ads" }, { sourceCode: "tg_ads" }],
    [{ kind: "source", code: "" }, { sourceCode: "" }],
    [{ kind: "meetup", payload: "m_AZLzpLXGfY6fChssPU5fYA" }, {}],
    [{ kind: "unclassified", payload: "anything" }, {}],
  ])("carries the channel code of %j as %j", (deepLink, expected) => {
    expect(hubRoleRequest(person, deepLink)).toEqual({
      telegramUserId: 42n,
      requestedRole: "member",
      firstName: "Сова",
      ...expected,
    });
  });
});

describe("decideHubEntry", () => {
  it.each<[RoleRequestOutcome, readonly string[], HubAccess]>([
    ["already-held", ["member", "public"], "admitted"],
    ["already-held", ["admin"], "admitted"],
    ["granted-by-allowlist", ["member", "public"], "admitted"],
    ["pending", [], "pending"],
    // Один `public` хаб не открывает: заявка на `member` ждёт решения.
    ["pending", ["public"], "pending"],
    ["declined", ["public"], "declined"],
    ["blocked", [], "blocked"],
  ])("answers %s with %j as %s", (outcome, globalRoles, access) => {
    expect(
      decideHubEntry({ kind: "answered", identityId, globalRoles, outcome }),
    ).toEqual({
      kind: "decided",
      person: { identityId, globalRoles },
      access,
    });
  });

  // Роль, которой словарь пакета не знает, до политики не доходит, а у
  // человека для диспетчера остаётся.
  it("keeps the roles of the answer for the dispatcher", () => {
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        globalRoles: ["unspecified", "member"],
        outcome: "already-held",
      }),
    ).toEqual({
      kind: "decided",
      person: { identityId, globalRoles: ["unspecified", "member"] },
      access: "admitted",
    });
  });

  it("does not enter on an outcome it does not know, whatever the roles", () => {
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        globalRoles: ["member", "public"],
        outcome: "unspecified",
      }),
    ).toEqual({ kind: "unknown-outcome", identityId });
  });
});
