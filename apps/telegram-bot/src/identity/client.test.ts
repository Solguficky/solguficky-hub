import { Code, ConnectError } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  createIdentityClient,
  createIdentityResolver,
  requestIdHeader,
} from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function failingResolver(cause: unknown) {
  return createIdentityResolver({
    resolveIdentity: () => Promise.reject(cause),
  });
}

describe("identity client", () => {
  it("returns unavailable when the transport deadline expires", async () => {
    const identity = failingResolver(
      new ConnectError("deadline", Code.DeadlineExceeded),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("returns unavailable when identity is down", async () => {
    const identity = failingResolver(
      new ConnectError("connect", Code.Unavailable),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("returns unavailable when the failure is not a connect error", async () => {
    const identity = failingResolver(new Error("socket closed"));
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("returns rejected when identity refuses the request as invalid", async () => {
    const identity = failingResolver(
      new ConnectError(
        "telegram_user_id must be positive",
        Code.InvalidArgument,
      ),
    );
    await expect(
      identity.resolve({ telegramUserId: 0n }),
    ).resolves.toMatchObject({ kind: "rejected", code: "InvalidArgument" });
  });

  it("returns rejected when the contract has drifted", async () => {
    const identity = failingResolver(
      new ConnectError("unknown method", Code.Unimplemented),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "rejected", code: "Unimplemented" });
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

  it("carries the request id to identity as a header", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return { identityId: "id-1", globalRoles: [] };
      },
    });
    await identity.resolve({ telegramUserId: 1n }, "req-42");
    expect(seenHeaders).toEqual({ [requestIdHeader]: "req-42" });
  });

  it("sends no request id header when the edge produced none", async () => {
    let seenHeaders: Record<string, string> | undefined = { sentinel: "unset" };
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return { identityId: "id-1", globalRoles: [] };
      },
    });
    await identity.resolve({ telegramUserId: 1n });
    expect(seenHeaders).toBeUndefined();
  });

  it("closes the http2 session on shutdown", () => {
    const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
    const identity = createIdentityClient("http://127.0.0.1:1");
    identity.close();
    expect(abort).toHaveBeenCalledOnce();
    abort.mockRestore();
  });
});
