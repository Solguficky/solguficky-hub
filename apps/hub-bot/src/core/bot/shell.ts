import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { TelegramEnvironment } from "../config.js";
import type { Tracing } from "../tracing.js";
import { traceUpdate } from "./tracing.js";

// Контекст update, общий у поверхностей: `request_id` записи границы и
// трейса, момент начала для `duration_us` и корневой спан update.
export type ShellContext = Context & {
  requestId: string;
  startedAt: bigint;
  updateSpan?: Span;
};

export type ShellOptions = {
  token: string;
  environment: TelegramEnvironment;
  tracing: Tracing;
  // Тесты передают его, чтобы не звать getMe.
  botInfo?: UserFromGetMe;
};

// Оболочка grammY, общая у поверхностей: бот своей среды, `request_id` и
// корневой спан update в первом middleware. Всё, что поверхность ставит
// ниже, включая вызовы Bot API и gRPC, становится потомком этого спана.
// Обработчики, тексты и отказ границы — у поверхности.
export function createBotShell<C extends ShellContext>(
  options: ShellOptions,
): Bot<C> {
  // Среда передаётся всегда, а не только для `test`: умолчание живёт в одном
  // месте, и отсутствие поля не читается как «grammY решит сам».
  const bot = new Bot<C>(options.token, {
    client: { environment: options.environment },
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  });
  bot.use((ctx, next) => {
    const requestId = randomUUID();
    ctx.requestId = requestId;
    ctx.startedAt = process.hrtime.bigint();
    return traceUpdate({ tracing: options.tracing, ctx, requestId, next });
  });
  return bot;
}
