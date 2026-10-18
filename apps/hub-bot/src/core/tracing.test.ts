import { Code, ConnectError } from "@connectrpc/connect";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { createRecordingTracing } from "../../testkit/tracing.js";
import { noopTracing, type Tracing, traceRpc } from "./tracing.js";

// Запрос interceptor'а в той части, которую он читает: имя сервиса и метода и
// заголовки. Транспорт не нужен — `next` подменяется.
function rpcRequest() {
  return {
    service: { typeName: "identity.v1.IdentityService" },
    method: { name: "ResolveIdentity" },
    header: new Headers(),
  };
}

async function callUnder(
  tracing: Tracing,
  next: (request: ReturnType<typeof rpcRequest>) => Promise<unknown>,
  withParent: boolean,
) {
  const request = rpcRequest();
  // Сгенерированных дескрипторов сервиса тесту не нужно: interceptor читает
  // только имена и заголовки, поэтому неполный запрос и `next` приводятся к
  // типам Connect.
  const call = () =>
    traceRpc(tracing)(next as never)(request as never) as Promise<unknown>;
  if (!withParent) {
    return { request, result: call() };
  }
  const root = tracing.tracer.startSpan("root", {}, ROOT_CONTEXT);
  const result = tracing.contexts.with(trace.setSpan(ROOT_CONTEXT, root), call);
  await result.catch(() => {});
  root.end();
  return { request, result, root };
}

describe("traceRpc", () => {
  it("sends traceparent of a client span under the active update span", async () => {
    const { tracing, exporter } = createRecordingTracing();
    let sent: string | null = null;

    const { root } = await callUnder(
      tracing,
      async (request) => {
        sent = request.header.get("traceparent");
        return {};
      },
      true,
    );

    const client = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.CLIENT);
    const rootContext = root?.spanContext();
    expect(client?.name).toBe("identity.v1.IdentityService/ResolveIdentity");
    expect(client?.parentSpanContext?.spanId).toBe(rootContext?.spanId);
    expect(client?.spanContext().traceId).toBe(rootContext?.traceId);
    expect(sent).toBe(
      `00-${rootContext?.traceId}-${client?.spanContext().spanId}-01`,
    );
    expect(client?.attributes).toEqual({
      "rpc.system": "grpc",
      "rpc.service": "identity.v1.IdentityService",
      "rpc.method": "ResolveIdentity",
      "rpc.grpc.status_code": 0,
    });
  });

  it("marks the client span failed with the gRPC code of the refusal", async () => {
    const { tracing, exporter } = createRecordingTracing();

    const { result } = await callUnder(
      tracing,
      async () => {
        throw new ConnectError("identity is down", Code.Unavailable);
      },
      true,
    );

    await expect(result).rejects.toBeInstanceOf(ConnectError);
    const client = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
    expect(client?.status.message).toBeUndefined();
    expect(client?.attributes["rpc.grpc.status_code"]).toBe(Code.Unavailable);
    expect(client?.attributes["error.type"]).toBe("Unavailable");
  });

  it("neither opens a span nor sends traceparent outside an update", async () => {
    const { tracing, exporter } = createRecordingTracing();

    const { request, result } = await callUnder(
      tracing,
      async () => ({}),
      false,
    );

    await result;
    expect(request.header.get("traceparent")).toBeNull();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("sends no traceparent when tracing is off", async () => {
    const tracing = noopTracing();

    const { request, result } = await callUnder(
      tracing,
      async () => ({}),
      true,
    );

    await result;
    expect(request.header.get("traceparent")).toBeNull();
  });
});
