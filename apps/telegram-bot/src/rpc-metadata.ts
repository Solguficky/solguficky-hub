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
  if (fields.requestId === undefined && fields.useCase === undefined) {
    return undefined;
  }
  return { requestId: fields.requestId, useCase: fields.useCase };
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
