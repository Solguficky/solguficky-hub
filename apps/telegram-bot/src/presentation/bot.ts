import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { Dispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";
import type { Logger } from "../logging.js";
import { parseUpdate } from "./parse-update.js";

export type BotRuntime = {
  token: string;
  dispatcher: Dispatcher;
  identity: IdentityResolver;
  logger: Logger;
};

const unavailableText = "недоступно";

export function createBot(runtime: BotRuntime): Bot {
  const bot = new Bot(runtime.token);
  bot.on("message", (ctx) => handleMessage(ctx, runtime));
  bot.catch((error) => {
    runtime.logger.error("update handler failed", {
      operation: "message",
      result: "error",
      error: error.message,
    });
  });
  return bot;
}

async function handleMessage(ctx: Context, runtime: BotRuntime): Promise<void> {
  const started = process.hrtime.bigint();
  const requestId = randomUUID();
  const parsed = parseUpdate(ctx.update);
  if (parsed.kind === "malformed") {
    runtime.logger.warn("malformed telegram update", {
      use_case: "acknowledge",
      operation: "message",
      result: "error",
      request_id: requestId,
      error_category: "malformed",
      duration_us: elapsedUs(started),
    });
    return;
  }
  if (parsed.kind === "ignored") {
    return;
  }
  const resolved = await runtime.identity.resolve(resolveInput(parsed));
  if (resolved.kind === "unavailable") {
    runtime.logger.error("identity unavailable", {
      use_case: "acknowledge",
      operation: "message",
      result: "error",
      request_id: requestId,
      error_category: "identity_unavailable",
      duration_us: elapsedUs(started),
    });
    await ctx.reply(unavailableText);
    return;
  }
  const result = runtime.dispatcher.execute({
    identity: {
      identityId: resolved.identityId,
      globalRoles: resolved.globalRoles,
    },
    intent: "acknowledge",
  });
  switch (result.kind) {
    case "stub":
      await ctx.reply(result.text);
      runtime.logger.info("stub reply sent", {
        use_case: "acknowledge",
        operation: "message",
        result: "ok",
        request_id: requestId,
        duration_us: elapsedUs(started),
      });
      return;
    case "rejected":
      runtime.logger.warn("dispatcher rejected request", {
        use_case: "acknowledge",
        operation: "message",
        result: "error",
        request_id: requestId,
        error_category: result.reason,
        duration_us: elapsedUs(started),
      });
      return;
    default: {
      const _exhaustive: never = result;
      runtime.logger.error("unhandled dispatcher result", {
        use_case: "acknowledge",
        operation: "message",
        result: "error",
        request_id: requestId,
        duration_us: elapsedUs(started),
        error: String(_exhaustive),
      });
    }
  }
}

function resolveInput(parsed: {
  telegramUserId: bigint;
  telegramUsername?: string;
}): { telegramUserId: bigint; telegramUsername?: string } {
  if (parsed.telegramUsername === undefined) {
    return { telegramUserId: parsed.telegramUserId };
  }
  return {
    telegramUserId: parsed.telegramUserId,
    telegramUsername: parsed.telegramUsername,
  };
}

function elapsedUs(started: bigint): number {
  return Number((process.hrtime.bigint() - started) / 1000n);
}
