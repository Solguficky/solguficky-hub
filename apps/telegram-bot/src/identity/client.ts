import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  GlobalRole,
  IdentityService,
} from "../../gen/identity/v1/identity_service_pb.js";
import {
  type IdentityResolver,
  type ResolveIdentityInput,
  toResolveIdentityInput,
} from "./port.js";

export const identityRpcTimeoutMs = 3_000;

export type IdentityRpc = {
  resolveIdentity(
    request: {
      telegramUserId: bigint;
      telegramUsername?: string;
    },
    options?: { timeoutMs?: number },
  ): Promise<{
    identityId: string;
    globalRoles: readonly GlobalRole[];
  }>;
};

export type IdentityClient = IdentityResolver & {
  close(): void;
};

export function createIdentityClient(
  baseUrl: string,
  timeoutMs = identityRpcTimeoutMs,
): IdentityClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const transport = createGrpcTransport({
    baseUrl,
    defaultTimeoutMs: timeoutMs,
    sessionManager,
  });
  const client = createClient(IdentityService, transport);
  const resolver = createIdentityResolver(client, timeoutMs);
  return {
    resolve: (input) => resolver.resolve(input),
    close() {
      sessionManager.abort();
    },
  };
}

export function createIdentityResolver(
  rpc: IdentityRpc,
  timeoutMs = identityRpcTimeoutMs,
): IdentityResolver {
  return {
    async resolve(input: ResolveIdentityInput) {
      try {
        const response = await withDeadline(
          rpc.resolveIdentity(toRequest(input), { timeoutMs }),
          timeoutMs,
        );
        return {
          kind: "resolved" as const,
          identityId: response.identityId,
          globalRoles: response.globalRoles.map(roleName),
        };
      } catch (cause) {
        return { kind: "unavailable" as const, cause };
      }
    },
  };
}

function toRequest(input: ResolveIdentityInput): {
  telegramUserId: bigint;
  telegramUsername?: string;
} {
  return toResolveIdentityInput(input.telegramUserId, input.telegramUsername);
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("identity rpc deadline exceeded"));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function roleName(role: GlobalRole): string {
  switch (role) {
    case GlobalRole.ADMIN:
      return "admin";
    case GlobalRole.UNSPECIFIED:
      return "unspecified";
    default: {
      const _exhaustive: never = role;
      return String(_exhaustive);
    }
  }
}
