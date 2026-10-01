import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type Context,
  type ContextManager,
  ProxyTracerProvider,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapPropagator,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { serviceName } from "./logging.js";

// Трассировка процесса — явная зависимость, как у Identity: ни провайдер, ни
// менеджер контекста, ни пропагатор не регистрируются глобально, и код,
// которому их не передали, трейсов не пишет, а не пишет их куда-то молча.
//
// Менеджер контекста на AsyncLocalStorage нужен ради одного пути: gRPC-клиенты
// создаются один раз на процесс, а зовёт их application-слой, который о
// трассировке не знает. Спан update доезжает до interceptor'а через асинхронную
// цепочку обработчика, а не через типы запросов.
export type Tracing = {
  tracer: Tracer;
  contexts: ContextManager;
  propagator: TextMapPropagator;
  shutdown(): Promise<void>;
};

// Опции фабрики gRPC-клиента: трассировка и токен вызывающего обязательны,
// чтобы клиент без них не собрался молча, а предел вызова у каждого клиента
// свой по умолчанию.
export type RpcClientOptions = {
  tracing: Tracing;
  /** Токен бота как вызывающего Identity, Meetups и Notifications (ADR-056). */
  serviceToken: string;
  timeoutMs?: number;
};

export function createTracing(
  tracer: Tracer,
  shutdown: () => Promise<void>,
): Tracing {
  return {
    tracer,
    contexts: new AsyncLocalStorageContextManager().enable(),
    propagator: new W3CTraceContextPropagator(),
    shutdown,
  };
}

// Без адреса OTLP трейсер no-op: спаны не записываются, `traceparent` не
// уходит, а обёртки ниже пропускают вызов насквозь по `isRecording`.
export function noopTracing(): Tracing {
  return createTracing(
    new ProxyTracerProvider().getTracer(serviceName),
    async () => {},
  );
}

// Записываемый спан в контексте или ничего. Дочерний спан открывается только
// под ним: вызов вне update — доставка из NATS, меню команд — иначе начинал бы
// отдельный трейс без корня.
export function recordingParent(context: Context): Span | undefined {
  const span = trace.getSpan(context);
  return span?.isRecording() === true ? span : undefined;
}

// Имя класса, а не текст: сообщение исключения может нести ввод человека.
export function errorType(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

const headerSetter = {
  set(carrier: Headers, key: string, value: string) {
    carrier.set(key, value);
  },
};

// Клиентский спан на каждый gRPC-вызов с `traceparent` в заголовках: серверный
// спан Identity, Meetups и Notifications становится его дочерним. Тело запроса
// в спан не попадает — ResolveIdentity несёт Telegram id и ник.
export function traceRpc(tracing: Tracing): Interceptor {
  return (next) => async (request) => {
    const parent = tracing.contexts.active();
    if (recordingParent(parent) === undefined) {
      return next(request);
    }
    const rpcService = request.service.typeName;
    const rpcMethod = request.method.name;
    const span = tracing.tracer.startSpan(
      `${rpcService}/${rpcMethod}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "rpc.system": "grpc",
          "rpc.service": rpcService,
          "rpc.method": rpcMethod,
        },
      },
      parent,
    );
    tracing.propagator.inject(
      trace.setSpan(parent, span),
      request.header,
      headerSetter,
    );
    try {
      const response = await next(request);
      // У Connect нет члена Code для успеха: OK в gRPC — ноль.
      span.setAttribute("rpc.grpc.status_code", 0);
      return response;
    } catch (cause) {
      const code = cause instanceof ConnectError ? cause.code : Code.Unknown;
      span.setAttribute("rpc.grpc.status_code", code);
      span.setAttribute("error.type", Code[code] ?? errorType(cause));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw cause;
    } finally {
      span.end();
    }
  };
}
