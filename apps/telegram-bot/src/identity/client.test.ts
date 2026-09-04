import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/identity_service_pb.js";
import { createIdentityClient, createIdentityResolver } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("closes the http2 session on shutdown", () => {
    const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
    const identity = createIdentityClient("http://127.0.0.1:1");
    identity.close();
    expect(abort).toHaveBeenCalledOnce();
    abort.mockRestore();
  });
});
