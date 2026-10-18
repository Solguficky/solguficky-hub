import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { Circle } from "../../../gen/identity/v1/access_pb.js";
import { IdentityService } from "../../../gen/identity/v1/identity_service_pb.js";
import {
  presentServiceToken,
  requestIdHeader,
} from "../../core/rpc-metadata.js";
import { type Tracing, traceRpc } from "../../core/tracing.js";
import type { CardCircle } from "./texts.js";

// Тип клиента берётся из схемы: Pick по сгенерированному Client роняет
// typecheck на первом расхождении с contracts/proto.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;

export const rpcTimeoutMs = 3_000;

/** Что бот поддержки берёт из личности: блокировку и круг карточки темы. */
export type Standing =
  | { blocked: true }
  | { blocked: false; circle: CardCircle };

export type StandingPort = {
  // Бросает при сбое Identity: решает вызывающий (ADR-068, п. 3).
  resolve(
    user: { telegramId: number; username?: string },
    requestId: string,
  ): Promise<Standing>;
};

// Круг словами карточки. Блокировку несёт свой флаг ответа: круг у
// заблокированного пуст так же, как у недопущенного.
function circleOf(circle: Circle): CardCircle {
  switch (circle) {
    case Circle.MEMBER:
      return "member";
    case Circle.GUEST:
      return "guest";
    default:
      return "none";
  }
}

export function createStandingPort(
  identity: IdentityRpc,
  timeoutMs: number = rpcTimeoutMs,
): StandingPort {
  return {
    async resolve(user, requestId) {
      // Разрешение личности заводит профиль постороннего так же, как
      // приветствие хаба (ADR-068, п. 3).
      const response = await identity.resolveIdentity(
        {
          telegramUserId: BigInt(user.telegramId),
          ...(user.username === undefined
            ? {}
            : { telegramUsername: user.username }),
        },
        { timeoutMs, headers: { [requestIdHeader]: requestId } },
      );
      return response.blocked
        ? { blocked: true }
        : { blocked: false, circle: circleOf(response.circle) };
    },
  };
}

export function createIdentityClient(options: {
  identityUrl: string;
  serviceToken: string;
  tracing: Tracing;
}): { standing: StandingPort; close(): void } {
  const session = new Http2SessionManager(options.identityUrl);
  const identity = createClient(
    IdentityService,
    createGrpcTransport({
      baseUrl: options.identityUrl,
      sessionManager: session,
      interceptors: [
        presentServiceToken(options.serviceToken),
        traceRpc(options.tracing),
      ],
    }),
  );
  return {
    standing: createStandingPort(identity),
    close: () => session.abort(),
  };
}
