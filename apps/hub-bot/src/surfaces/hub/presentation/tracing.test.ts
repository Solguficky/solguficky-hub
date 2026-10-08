import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { Api, Context } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { botInfo, createHarness } from "../../../../testkit/harness.js";
import { createRecordingTracing } from "../../../../testkit/tracing.js";
import { traceBotApi, traceUpdate } from "../../../core/bot/tracing.js";
import { noopTracing, type Tracing } from "../../../core/tracing.js";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";

// Значения, которых не должно быть ни в одном атрибуте: Telegram id, ник и
// текст сообщения. Они заметны в сериализованных атрибутах, в отличие от 42.
const telegramUserId = 987_654_321;
const username = "alice_nick";
const text = "/start";

function startUpdate(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: telegramUserId, type: "private", first_name: "Alice" },
      from: {
        id: telegramUserId,
        is_bot: false,
        first_name: "Alice",
        username,
      },
      text,
    },
  };
}

// Identity, который запоминает трейс, активный в момент вызова: так тест видит,
// что спан update доезжает до порта через application-слой, а gRPC-interceptor
// возьмёт его оттуда же.
function tracingIdentity(tracing: Tracing): IdentityResolver & {
  seenTraceId?: string | undefined;
} {
  const identity: IdentityResolver & { seenTraceId?: string | undefined } = {
    resolve: async () => {
      identity.seenTraceId = trace
        .getSpan(tracing.contexts.active())
        ?.spanContext().traceId;
      return {
        kind: "resolved",
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: ["member"],
        blocked: false,
      };
    },
  };
  return identity;
}

describe("update trace", () => {
  it("shows /start as one trace from the update to the Bot API reply", async () => {
    const { tracing, exporter } = createRecordingTracing();
    const identity = tracingIdentity(tracing);
    const { bot, calls, records } = createHarness(
      identity,
      createDispatcher(),
      [],
      tracing,
    );

    await bot.handleUpdate(startUpdate());

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.parentSpanContext === undefined);
    const traceId = root?.spanContext().traceId;
    expect(root?.name).toBe("telegram.update message");
    expect(root?.kind).toBe(SpanKind.CONSUMER);
    expect(root?.attributes["telegram.update.type"]).toBe("message");
    expect(root?.attributes["request_id"]).toBe(records[0]?.fields.request_id);
    expect(identity.seenTraceId).toBe(traceId);

    const reply = spans.find(
      (span) => span.name === "telegram.bot_api sendMessage",
    );
    expect(calls.map((call) => call.method)).toContain("sendMessage");
    expect(reply?.kind).toBe(SpanKind.CLIENT);
    expect(reply?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(spans.every((span) => span.spanContext().traceId === traceId)).toBe(
      true,
    );
  });

  it("keeps Telegram id, username and message text out of span attributes", async () => {
    const { tracing, exporter } = createRecordingTracing();
    const { bot } = createHarness(
      tracingIdentity(tracing),
      createDispatcher(),
      [],
      tracing,
    );

    await bot.handleUpdate(startUpdate());

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(1);
    const attributes = JSON.stringify(spans.map((span) => span.attributes));
    expect(attributes).not.toContain(String(telegramUserId));
    expect(attributes).not.toContain(username);
    expect(attributes).not.toContain(text);
    expect(attributes).not.toContain("Alice");
  });

  it("answers without spans when tracing is off", async () => {
    const tracing = noopTracing();
    const { bot, calls } = createHarness(
      tracingIdentity(tracing),
      createDispatcher(),
      [],
      tracing,
    );

    await bot.handleUpdate(startUpdate());

    expect(calls.map((call) => call.method)).toContain("sendMessage");
  });

  it("marks the update failed by category when the handler records a refusal", async () => {
    const { tracing, exporter } = createRecordingTracing();
    const unavailable: IdentityResolver = {
      resolve: async () => ({
        kind: "unavailable",
        cause: new Error("connect ECONNREFUSED"),
      }),
    };
    const { bot, records } = createHarness(
      unavailable,
      createDispatcher(),
      [],
      tracing,
    );

    await bot.handleUpdate(startUpdate());

    const root = exporter
      .getFinishedSpans()
      .find((span) => span.parentSpanContext === undefined);
    expect(root?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(root?.attributes["error.type"]).toBe(
      records.at(-1)?.fields.error_category,
    );
  });

  it("closes the update span as failed when the handler throws", async () => {
    const { tracing, exporter } = createRecordingTracing();
    const ctx = new Context(startUpdate(), new Api("111:test-token"), botInfo);

    const handled = traceUpdate({
      tracing,
      ctx,
      requestId: "request-1",
      next: async () => {
        throw new TypeError("handler defect");
      },
    });

    await expect(handled).rejects.toBeInstanceOf(TypeError);
    const [root] = exporter.getFinishedSpans();
    expect(root?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(root?.attributes["error.type"]).toBe("TypeError");
  });
});

describe("traceBotApi", () => {
  it("marks a refused call failed by error code without its description", async () => {
    const { tracing, exporter } = createRecordingTracing();
    const root = tracing.tracer.startSpan("root");
    const transformer = traceBotApi(
      tracing,
      trace.setSpan(tracing.contexts.active(), root),
    );

    const response = await transformer(
      async () => ({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
      "sendMessage",
      { chat_id: telegramUserId, text: "hello" },
    );

    expect(response.ok).toBe(false);
    const [call] = exporter.getFinishedSpans();
    expect(call?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(call?.attributes).toEqual({
      "telegram.bot_api.method": "sendMessage",
      "telegram.bot_api.error_code": 403,
      "error.type": "403",
    });
  });
});
