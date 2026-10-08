import { describe, expect, it } from "vitest";
import type {
  AccessRight,
  RoleRequestOutcome,
} from "../../../auction-ui/index.js";
import type { HubAccess } from "../application/hub-access.js";
import type { DeepLink } from "../application/types.js";
import { decideHubEntry, hubRoleRequest } from "./hub-entry.js";

const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const person = { telegramUserId: 42n, firstName: "Сова" };

describe("hubRoleRequest", () => {
  it("applies to the community queue with the first name", () => {
    expect(
      hubRoleRequest({ ...person, telegramUsername: "owl" }, undefined),
    ).toEqual({
      telegramUserId: 42n,
      telegramUsername: "owl",
      queue: "community",
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
      queue: "community",
      firstName: "Сова",
      ...expected,
    });
  });
});

describe("decideHubEntry", () => {
  it.each<[RoleRequestOutcome, readonly AccessRight[], HubAccess]>([
    ["already-held", ["hub", "auction"], "admitted"],
    ["already-held", ["hub", "auction", "manage-membership"], "admitted"],
    ["granted-by-allowlist", ["hub", "auction"], "admitted"],
    ["pending", [], "pending"],
    // Право аукциона хаб не открывает: заявка на участника ждёт решения.
    ["pending", ["auction"], "pending"],
    ["declined", ["auction"], "declined"],
    ["blocked", [], "blocked"],
  ])("answers %s with %j as %s", (outcome, rights, access) => {
    const globalRoles = ["member"];
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        globalRoles,
        rights,
        outcome,
      }),
    ).toEqual({
      kind: "decided",
      person: { identityId, globalRoles, rights },
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
        rights: ["hub", "auction"],
        outcome: "already-held",
      }),
    ).toEqual({
      kind: "decided",
      person: {
        identityId,
        globalRoles: ["unspecified", "member"],
        rights: ["hub", "auction"],
      },
      access: "admitted",
    });
  });

  it("does not enter on an outcome it does not know, whatever the rights", () => {
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        globalRoles: ["member", "public"],
        rights: ["hub", "auction"],
        outcome: "unspecified",
      }),
    ).toEqual({ kind: "unknown-outcome", identityId });
  });
});
