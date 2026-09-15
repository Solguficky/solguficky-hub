export const requestIdHeader = "x-request-id";
export const useCaseHeader = "x-use-case";

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
