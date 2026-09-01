import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/identity_service_pb.js";
import { createIdentityResolver } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("identity client", () => {
  it("returns unavailable when the rpc never completes", async () => {
    vi.useFakeTimers();
    const identity = createIdentityResolver(
      { resolveIdentity: () => new Promise<never>(() => {}) },
      40,
    );
    const pending = identity.resolve({ telegramUserId: 1n });
    await vi.advanceTimersByTimeAsync(39);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("passes timeoutMs to the rpc and maps success", async () => {
    let seenTimeout: number | undefined;
    const identity = createIdentityResolver(
      {
        resolveIdentity: async (_request, options) => {
          seenTimeout = options?.timeoutMs;
          return { identityId: "id-1", globalRoles: [GlobalRole.ADMIN] };
        },
      },
      75,
    );
    await expect(
      identity.resolve({ telegramUserId: 1n, telegramUsername: "alice" }),
    ).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      globalRoles: ["admin"],
    });
    expect(seenTimeout).toBe(75);
  });
});
