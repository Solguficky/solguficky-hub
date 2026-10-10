import { describe, expect, it } from "vitest";
import type {
  AccessRequestOutcome,
  AccessRight,
} from "../../../auction-ui/index.js";
import type { HubAccess } from "../application/hub-access.js";
import type { DeepLink } from "../application/types.js";
import { decideHubEntry, hubAccessRequest } from "./hub-entry.js";

const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const person = { telegramUserId: 42n, firstName: "Сова" };

describe("hubAccessRequest", () => {
  it("applies to the community queue with the first name", () => {
    expect(
      hubAccessRequest({ ...person, telegramUsername: "owl" }, undefined),
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
    expect(hubAccessRequest(person, deepLink)).toEqual({
      telegramUserId: 42n,
      queue: "community",
      firstName: "Сова",
      ...expected,
    });
  });
});

describe("decideHubEntry", () => {
  it.each<[AccessRequestOutcome, readonly AccessRight[], HubAccess]>([
    ["already-held", ["access-hub", "place-bids"], "admitted"],
    [
      "already-held",
      ["access-hub", "place-bids", "manage-members"],
      "admitted",
    ],
    ["granted-by-allowlist", ["access-hub", "place-bids"], "admitted"],
    ["pending", [], "pending"],
    // Право аукциона хаб не открывает: заявка на участника ждёт решения.
    ["pending", ["place-bids"], "pending"],
    ["declined", ["place-bids"], "declined"],
    ["blocked", [], "blocked"],
  ])("answers %s with %j as %s", (outcome, rights, access) => {
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        rights,
        outcome,
      }),
    ).toEqual({
      kind: "decided",
      person: { identityId, rights },
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
        rights: ["access-hub", "place-bids"],
        outcome: "already-held",
      }),
    ).toEqual({
      kind: "decided",
      person: {
        identityId,
        rights: ["access-hub", "place-bids"],
      },
      access: "admitted",
    });
  });

  it("does not enter on an outcome it does not know, whatever the rights", () => {
    expect(
      decideHubEntry({
        kind: "answered",
        identityId,
        rights: ["access-hub", "place-bids"],
        outcome: "unspecified",
      }),
    ).toEqual({ kind: "unknown-outcome", identityId });
  });
});
