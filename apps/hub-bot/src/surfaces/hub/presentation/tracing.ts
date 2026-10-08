import {
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Context as TraceContext,
  trace,
} from "@opentelemetry/api";
import type { Context, NextFunction, Transformer } from "grammy";
import type { Update } from "grammy/types";
import type { FailureCategory } from "../../../core/failures.js";
import {
  errorType,
  recordingParent,
  type Tracing,
} from "../../../core/tracing.js";

// Корневой спан update. Корень всегда новый: входящего `traceparent` у
// Telegram нет, а контекст предыдущего update сюда попасть не должен. Вид —
// CONSUMER: бот сам забирает update из очереди Bot API, а ответ уходит
// отдельными вызовами, а не ответом на запрос.
//
// Атрибуты — только тип update и `request_id`, тот же, что в записи границы.
// Текст, ник, Telegram id и chat id не пишутся (logging.md, «Персональные
// данные»).
// Контекст update несёт свой спан, чтобы запись границы пометила его отказом:
// обработчики ловят исключения сами, и наружу, в catch ниже, доходит только
// дефект мимо них.
export type TracedContext = Context & { updateSpan?: Span };

export async function traceUpdate(update: {
  tracing: Tracing;
  ctx: TracedContext;
  requestId: string;
  next: NextFunction;
}): Promise<void> {
  const { tracing, ctx, requestId, next } = update;
  const type = updateType(ctx.update);
  const span = tracing.tracer.startSpan(
    `telegram.update ${type}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: { "telegram.update.type": type, request_id: requestId },
    },
    ROOT_CONTEXT,
  );
  const context = trace.setSpan(ROOT_CONTEXT, span);
  ctx.updateSpan = span;
  // Transformer ставится на ctx.api этого update, а не на bot.api: так он
  // оказывается снаружи transformer'ов бота и знает свой родитель без
  // AsyncLocalStorage, а getUpdates и вызовы вне update его не проходят. Без
  // экспорта спан не записывается, и обёртка не ставится вовсе.
  if (span.isRecording()) {
    ctx.api.config.use(traceBotApi(tracing, context));
  }
  try {
    await tracing.contexts.with(context, next);
  } catch (cause) {
    markFailed(span, cause);
    throw cause;
  } finally {
    span.end();
  }
}

// Дочерний спан на каждый вызов Bot API. Payload и описание ошибки не пишутся:
// в них текст сообщения и chat id.
export function traceBotApi(
  tracing: Tracing,
  parent: TraceContext,
): Transformer {
  return async (prev, method, payload, signal) => {
    // Вызов без await, завершившийся после update, спана не получает — как и
    // gRPC-вызов в той же ситуации.
    if (recordingParent(parent) === undefined) {
      return prev(method, payload, signal);
    }
    const span = tracing.tracer.startSpan(
      `telegram.bot_api ${method}`,
      {
        kind: SpanKind.CLIENT,
        attributes: { "telegram.bot_api.method": method },
      },
      parent,
    );
    try {
      const response = await prev(method, payload, signal);
      if (!response.ok) {
        span.setAttribute("telegram.bot_api.error_code", response.error_code);
        span.setAttribute("error.type", String(response.error_code));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return response;
    } catch (cause) {
      markFailed(span, cause);
      throw cause;
    } finally {
      span.end();
    }
  };
}

// Отказ, который обработчик поймал и записал границей, помечает корень update
// категорией отказа — это имя из словаря, а не текст ошибки. Закрытый спан
// (запись из bot.catch идёт после него) не трогается.
export function markUpdateFailed(
  span: Span | undefined,
  category: FailureCategory,
): void {
  if (span?.isRecording() !== true) {
    return;
  }
  span.setAttribute("error.type", category);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function markFailed(span: Span, cause: unknown): void {
  span.setAttribute("error.type", errorType(cause));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function updateType(update: Update): string {
  return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}
