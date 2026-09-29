import { describe, expect, it } from "vitest";
import {
  applicationCode,
  blockedHubAccessText,
  decideHubAccess,
  hubAccessErrors,
  hubAccessText,
  pendingHubAccessText,
} from "./hub-access.js";

describe("decideHubAccess", () => {
  it("admits a person who has the member role", () => {
    expect(decideHubAccess(["member"], false)).toBe("admitted");
  });

  it("admits nested admin and maintainer as the member circle", () => {
    expect(decideHubAccess(["admin"], false)).toBe("admitted");
    expect(decideHubAccess(["maintainer"], false)).toBe("admitted");
  });

  it("admits a member even when other roles are present", () => {
    expect(decideHubAccess(["admin", "member", "public"], false)).toBe(
      "admitted",
    );
  });

  it("keeps a person outside the member circle in pending", () => {
    expect(decideHubAccess([], false)).toBe("pending");
    expect(decideHubAccess(["public"], false)).toBe("pending");
  });

  it("closes access when the blocked mark is set", () => {
    expect(decideHubAccess([], true)).toBe("blocked");
    expect(decideHubAccess(["member"], true)).toBe("blocked");
    expect(decideHubAccess(["admin"], true)).toBe("blocked");
  });

  it("names pending and blocked refusals differently", () => {
    expect(hubAccessErrors.pending).toBe("hub_access_pending");
    expect(hubAccessErrors.blocked).toBe("hub_access_blocked");
    expect(hubAccessText("pending", identityId)).toContain("ждёт проверки");
    expect(hubAccessText("blocked", identityId)).toBe(blockedHubAccessText);
    expect(blockedHubAccessText).toContain("закрыт");
  });
});

const identityId = "01a0e306-a646-7d3a-9b21-4f8e12ab34cd";

describe("applicationCode", () => {
  it("tells apart profiles created within the same minute", () => {
    const neighbour = "01a0e306-918c-7e01-8c55-0d2f6a7b9e10";
    expect(applicationCode(identityId)).not.toBe(applicationCode(neighbour));
    expect(applicationCode(identityId)).not.toContain("01a0e306");
  });

  it("is shown to the waiting person in the pending frame", () => {
    expect(pendingHubAccessText(identityId)).toContain(
      `код заявки: ${applicationCode(identityId)}`,
    );
  });
});
