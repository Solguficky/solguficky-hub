import type { KvEntry } from "@nats-io/kv";
import type { Transformer } from "grammy";
import { noopTracing } from "../src/core/tracing.js";
import { createBot } from "../src/surfaces/support/bot.js";
import type { StandingPort } from "../src/surfaces/support/identity.js";
import {
  createPairStore,
  type PairKv,
  type PairStore,
} from "../src/surfaces/support/pairs.js";
import type { RateLimiter } from "../src/surfaces/support/rate-limit.js";
import {
  type ApiMethod,
  type ApiPayload,
  botInfo,
  createCapturingLogger,
  type RecordedCall,
} from "./harness.js";

// Харнесс поверхности поддержки без Telegram и без NATS. Экранов у неё нет
// (ADR-068), поэтому линтер экранов вызовы не проверяет: они записываются, а
// ответ Telegram подставляется.

export const supportBotInfo = { ...botInfo, username: "stub_support_bot" };

export const supportGroupId = -1001234567890;

export type MemoryKv = PairKv & { ops: string[]; values: Map<string, string> };

/**
 * KV в памяти ровно в той части, которую трогает хранилище пар. `ops` —
 * порядок записей: ADR-068 п. 8 требует «тема → человек» первой. `fail`
 * роняет операцию, чтобы показать сбой между двумя записями.
 */
export function createMemoryKv(
  fail: (op: "get" | "put" | "delete", key: string) => boolean = () => false,
): MemoryKv {
  const values = new Map<string, string>();
  const deleted = new Set<string>();
  const ops: string[] = [];
  const entry = (value: string, operation: KvEntry["operation"]) =>
    ({ operation, string: () => value }) as unknown as KvEntry;
  return {
    ops,
    values,
    get: async (key: string) => {
      if (fail("get", key)) throw new Error("kv unavailable");
      const value = values.get(key);
      if (value !== undefined) return entry(value, "PUT");
      return deleted.has(key) ? entry("", "DEL") : null;
    },
    put: async (key: string, data: unknown) => {
      if (fail("put", key)) throw new Error("kv unavailable");
      ops.push(`put ${key}`);
      values.set(key, String(data));
      deleted.delete(key);
      return values.size;
    },
    delete: async (key: string) => {
      if (fail("delete", key)) throw new Error("kv unavailable");
      ops.push(`delete ${key}`);
      values.delete(key);
      deleted.add(key);
    },
  } as MemoryKv;
}

export type SupportRespond = (
  method: ApiMethod,
  payload: ApiPayload,
) => unknown;

// Ответ Telegram по умолчанию: тема получает следующий номер, копия и
// отправка — новый номер сообщения.
function defaultAnswer(
  method: ApiMethod,
  payload: ApiPayload,
  counters: { thread: number; message: number },
): unknown {
  switch (method) {
    case "createForumTopic":
      counters.thread += 1;
      return {
        message_thread_id: counters.thread,
        name: (payload as { name: string }).name,
        icon_color: 7322096,
      };
    case "copyMessage":
      counters.message += 1;
      return { message_id: counters.message };
    case "sendMessage":
      counters.message += 1;
      return {
        message_id: counters.message,
        date: 0,
        chat: { id: (payload as { chat_id: number }).chat_id, type: "private" },
        text: (payload as { text: string }).text,
      };
    default:
      return true;
  }
}

/**
 * Бот поддержки на записи вызовов. `kv` передаётся снаружи, чтобы показать
 * рестарт процесса: новый бот теряет память, а bucket остаётся.
 */
export function createSupportHarness(
  options: {
    standing?: StandingPort;
    kv?: MemoryKv;
    groupId?: number;
    respond?: SupportRespond;
    limiter?: RateLimiter;
    now?: () => Date;
    // Номер последней темы: новый бот после рестарта не повторяет номера.
    firstThread?: number;
  } = {},
) {
  const { logger, records } = createCapturingLogger();
  const calls: RecordedCall[] = [];
  const kv = options.kv ?? createMemoryKv();
  const groupId = options.groupId ?? supportGroupId;
  const pairs: PairStore = createPairStore(kv, groupId);
  const counters = { thread: options.firstThread ?? 0, message: 100 };
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    tracing: noopTracing(),
    logger,
    groupId,
    timeZone: "Europe/Moscow",
    standing: options.standing ?? {
      resolve: async () => ({ blocked: false, circle: "member" }),
    },
    pairs: () => pairs,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    now: options.now ?? (() => new Date("2026-10-14T09:00:00Z")),
    botInfo: supportBotInfo,
  });
  const transformer: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    const answer = options.respond?.(method, payload);
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "object" && answer !== null && "ok" in answer) {
      return Promise.resolve(answer as never);
    }
    return Promise.resolve({
      ok: true,
      result: (answer ?? defaultAnswer(method, payload, counters)) as never,
    });
  };
  bot.api.config.use(transformer);
  return { bot, calls, records, kv, pairs };
}

/** Отказ Bot API в той форме, из которой grammY собирает GrammyError. */
export function refusal(error_code: number, description: string) {
  return { ok: false, error_code, description };
}
