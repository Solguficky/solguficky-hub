import type { Interceptor } from "@connectrpc/connect";

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
};

export function rpcMeta(fields: {
  requestId?: string;
  useCase?: string;
}): RpcMetadata | undefined {
  const meta: RpcMetadata = {};
  if (fields.requestId !== undefined) {
    meta.requestId = fields.requestId;
  }
  if (fields.useCase !== undefined) {
    meta.useCase = fields.useCase;
  }
  if (meta.requestId === undefined && meta.useCase === undefined) {
    return undefined;
  }
  return meta;
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
