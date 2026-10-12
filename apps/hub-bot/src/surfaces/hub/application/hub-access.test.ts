import { describe, expect, it } from "vitest";
import {
  applicationCode,
  blockedHubAccessText,
  decideHubAccess,
  declinedHubAccessText,
  hubAccessErrors,
  hubAccessText,
  pendingHubAccessText,
} from "./hub-access.js";

const identityId = "01a0e306-a646-7d3a-9b21-4f8e12ab34cd";

describe("decideHubAccess", () => {
  it("admits a person who has the hub right", () => {
    expect(decideHubAccess(["access-hub", "place-bids"], false)).toBe(
      "admitted",
    );
    expect(
      decideHubAccess(
        ["access-hub", "place-bids", "manage-members", "admit-bidders"],
        false,
      ),
    ).toBe("admitted");
  });

  // Права выводит Identity: бот не достраивает право хаба ни из права
  // модерации, ни из права аукциона. Есть ли заявка, разрешение личности не
  // знает: без права — приветствие с кнопкой заявки (PER-592).
  it("keeps a person without the hub right unapplied", () => {
    expect(decideHubAccess([], false)).toBe("unapplied");
    expect(decideHubAccess(["place-bids"], false)).toBe("unapplied");
    expect(decideHubAccess(["place-bids", "admit-bidders"], false)).toBe(
      "unapplied",
    );
  });

  it("closes access when the blocked mark is set", () => {
    expect(decideHubAccess([], true)).toBe("blocked");
    expect(decideHubAccess(["access-hub", "place-bids"], true)).toBe("blocked");
  });

  it("names pending, declined and blocked refusals differently", () => {
    expect(hubAccessErrors.pending).toBe("hub_access_pending");
    expect(hubAccessErrors.declined).toBe("hub_access_declined");
    expect(hubAccessText("declined", identityId, undefined)).toBe(
      declinedHubAccessText,
    );
    // Три отказа — три разных ответа: получивший отказ и заблокированный не
    // читают «заявка ждёт проверки» (ADR-060, пункты 13 и 15).
    expect(
      new Set(
        (["pending", "declined", "blocked"] as const).map((access) =>
          hubAccessText(access, identityId, undefined),
        ),
      ).size,
    ).toBe(3);
    expect(hubAccessErrors.blocked).toBe("hub_access_blocked");
    expect(hubAccessText("pending", identityId, undefined)).toContain(
      "ждёт проверки",
    );
    expect(hubAccessText("blocked", identityId, undefined)).toBe(
      blockedHubAccessText,
    );
    expect(blockedHubAccessText).toContain("закрыт");
  });
});

describe("applicationCode", () => {
  it("tells apart profiles created within the same minute", () => {
    const neighbour = "01a0e306-918c-7e01-8c55-0d2f6a7b9e10";
    expect(applicationCode(identityId)).not.toBe(applicationCode(neighbour));
    expect(applicationCode(identityId)).not.toContain("01a0e306");
  });

  it("is shown to a waiting person without a username", () => {
    expect(pendingHubAccessText(identityId, undefined)).toContain(
      `код заявки: ${applicationCode(identityId)}`,
    );
  });

  it("is not shown to a waiting person with a username", () => {
    const text = pendingHubAccessText(identityId, "vasya");
    expect(text).not.toContain(applicationCode(identityId));
    expect(text).toContain("по твоему нику");
  });
});
