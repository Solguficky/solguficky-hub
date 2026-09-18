import { describe, expect, it } from "vitest";
import {
  blockedHubAccessText,
  decideHubAccess,
  hubAccessErrors,
  pendingHubAccessText,
} from "./hub-access.js";

describe("decideHubAccess", () => {
  it("admits a person who has the member role", () => {
    expect(decideHubAccess(["member"], false)).toBe("admitted");
  });

  it("admits a member even when other roles are present", () => {
    expect(decideHubAccess(["admin", "member", "public"], false)).toBe(
      "admitted",
    );
  });

  it("keeps a person without member in pending", () => {
    expect(decideHubAccess([], false)).toBe("pending");
    expect(decideHubAccess(["admin"], false)).toBe("pending");
    expect(decideHubAccess(["public"], false)).toBe("pending");
    expect(decideHubAccess(["maintainer"], false)).toBe("pending");
  });

  it("closes access when the blocked mark is set", () => {
    expect(decideHubAccess([], true)).toBe("blocked");
    expect(decideHubAccess(["member"], true)).toBe("blocked");
  });

  it("names pending and blocked refusals differently", () => {
    expect(hubAccessErrors.pending).toBe("hub_access_pending");
    expect(hubAccessErrors.blocked).toBe("hub_access_blocked");
    expect(pendingHubAccessText).toContain("ждёт проверки");
    expect(blockedHubAccessText).toContain("закрыт");
    expect(pendingHubAccessText).not.toBe(blockedHubAccessText);
  });
});
