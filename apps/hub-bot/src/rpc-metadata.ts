import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";

export const requestIdHeader = "x-request-id";
export const useCaseHeader = "x-use-case";
export const authorizationHeader = "authorization";

// Токен вызывающего (ADR-056) — свойство процесса, а не запроса, поэтому он
// ставится транспортом на каждый вызов, а не едет в RpcMetadata через адаптеры:
// клиент без него не собирается, и забыть заголовок в новом методе нельзя.
export function presentServiceToken(token: string): Interceptor {
  const value = `Bearer ${token}`;
  return (next) => (request) => {
    request.header.set(authorizationHeader, value);
    return next(request);
  };
}

export type RpcMetadata = {
  requestId?: string;
  useCase?: string;
  /**
   * Момент, после которого действие к сервисам больше не ходит: общий бюджет
   * ожидания одного update, а не дедлайн отдельного вызова.
   */
  deadlineAt?: number;
};

export function rpcMeta(fields: RpcMetadata): RpcMetadata | undefined {
  const meta: RpcMetadata = {};
  if (fields.requestId !== undefined) {
    meta.requestId = fields.requestId;
  }
  if (fields.useCase !== undefined) {
    meta.useCase = fields.useCase;
  }
  if (fields.deadlineAt !== undefined) {
    meta.deadlineAt = fields.deadlineAt;
  }
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/**
 * Дедлайн одного вызова: меньшее из его собственного и остатка бюджета
 * действия. Бюджет исчерпан — вызов не делается вовсе, а отказ тот же, что даёт
 * истёкший дедлайн транспорта: адаптеры разбирают его уже существующей ветвью.
 */
export function callTimeoutMs(
  meta: RpcMetadata | undefined,
  ownMs: number,
  now: number = Date.now(),
): number {
  if (meta?.deadlineAt === undefined) return ownMs;
  const left = meta.deadlineAt - now;
  if (left <= 0) {
    throw new ConnectError(
      "the action budget is exhausted",
      Code.DeadlineExceeded,
    );
  }
  return Math.min(ownMs, left);
}

export function callHeaders(meta?: RpcMetadata): {
  headers?: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  if (meta?.requestId !== undefined && meta.requestId !== "") {
    headers[requestIdHeader] = meta.requestId;
  }
  if (meta?.useCase !== undefined && meta.useCase !== "") {
    headers[useCaseHeader] = meta.useCase;
  }
  if (Object.keys(headers).length === 0) {
    return {};
  }
  return { headers };
}
