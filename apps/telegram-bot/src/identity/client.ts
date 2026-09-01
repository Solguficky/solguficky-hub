import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  GlobalRole,
  IdentityService,
} from "../../gen/identity/v1/identity_service_pb.js";
import type { IdentityResolver, ResolveIdentityInput } from "./port.js";

export function createIdentityClient(baseUrl: string): IdentityResolver {
  const transport = createGrpcTransport({
    baseUrl,
  });
  const client = createClient(IdentityService, transport);
  return {
    async resolve(input: ResolveIdentityInput) {
      try {
        const response = await client.resolveIdentity(toRequest(input));
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
  if (input.telegramUsername === undefined) {
    return { telegramUserId: input.telegramUserId };
  }
  return {
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername,
  };
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
