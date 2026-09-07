import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { IdentityService } from "../../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import type {
  IdentityResolver,
  ResolveIdentityInput,
  ResolveIdentityResult,
} from "./port.js";

export const identityRpcTimeoutMs = 3_000;

export const requestIdHeader = "x-request-id";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: рукописная
// копия форм запроса, ответа и CallOptions расходится с contracts/proto молча,
// а Pick по сгенерированному Client роняет typecheck на первом же расхождении.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;

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
    resolve: (input, requestId) => resolver.resolve(input, requestId),
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
    async resolve(input: ResolveIdentityInput, requestId?: string) {
      try {
        // Дедлайн один и принадлежит транспорту: он же отменяет вызов и даёт
        // ConnectError с кодом. Рукописная гонка таймеров рядом отдавала голую
        // ошибку без кода и поток не отменяла.
        const response = await rpc.resolveIdentity(input, {
          timeoutMs,
          ...callHeaders(requestId),
        });
        return {
          kind: "resolved" as const,
          identityId: response.identityId,
          globalRoles: response.globalRoles.map(roleName),
        };
      } catch (cause) {
        return classifyFailure(cause);
      }
    },
  };
}

function callHeaders(requestId: string | undefined): {
  headers?: Record<string, string>;
} {
  if (requestId === undefined || requestId === "") {
    return {};
  }
  return { headers: { [requestIdHeader]: requestId } };
}

// Отказ, который не пройдёт и со второй попытки: нарушение контракта, рассинхрон
// схемы, отсутствующий метод. Всё остальное — недоступность зависимости, где
// повтор осмыслен.
const permanentCodes: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.AlreadyExists,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.FailedPrecondition,
  Code.OutOfRange,
  Code.Unimplemented,
]);

function classifyFailure(cause: unknown): ResolveIdentityResult {
  if (cause instanceof ConnectError && permanentCodes.has(cause.code)) {
    return { kind: "rejected", code: Code[cause.code], cause };
  }
  return { kind: "unavailable", cause };
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
