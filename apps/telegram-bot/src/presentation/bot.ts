import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { Dispatcher } from "../application/dispatcher.js";
import { startExecuteRequest } from "../application/types.js";
import {
  type IdentityResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import { parseUpdate } from "./parse-update.js";

export type BotRuntime = {
  token: string;
  dispatcher: Dispatcher;
  identity: IdentityResolver;
  logger: Logger;
};

const unavailableText = `Не получилось загрузить данные. Это на моей стороне.

Попробуй ещё раз через минуту.`;
const operation = "message";

type UpdateContext = Context & {
  requestId?: string;
  startedAt?: bigint;
};

type BoundaryOutcome =
  | {
      level: "debug";
      message: string;
      result: "ok";
      use_case?: string;
    }
  | {
      level: "warn" | "error";
      message: string;
      result: "error";
      use_case?: string;
      error_category: string;
      error: string;
      stack?: string;
    };

export function createBot(runtime: BotRuntime): Bot<UpdateContext> {
  const bot = new Bot<UpdateContext>(runtime.token);
  bot.use((ctx, next) => {
    ctx.requestId = randomUUID();
    ctx.startedAt = process.hrtime.bigint();
    return next();
  });
  bot.on("message", (ctx) => handleMessage(ctx, runtime));
  bot.catch((botError) => {
    writeBoundary(
      runtime.logger,
      botError.ctx,
      unexpectedOutcome(botError.error, botError),
    );
  });
  return bot;
}

async function handleMessage(
  ctx: UpdateContext,
  runtime: BotRuntime,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  try {
    const parsed = parseUpdate(ctx.update, ctx.me.username);
    if (parsed.kind === "malformed") {
      outcome = {
        level: "warn",
        message: "malformed telegram update",
        result: "error",
        error_category: "malformed",
        error: "telegram update failed validation",
      };
      return;
    }
    if (parsed.kind === "ignored") {
      outcome = {
        level: "debug",
        message: "update ignored",
        result: "ok",
      };
      return;
    }
    const resolved = await runtime.identity.resolve(
      toResolveIdentityInput(parsed.telegramUserId, parsed.telegramUsername),
    );
    if (resolved.kind === "unavailable") {
      outcome = {
        level: "error",
        message: "identity unavailable",
        result: "error",
        use_case: "start",
        error_category: "identity_unavailable",
        error: errorText(resolved.cause),
      };
      await ctx.reply(unavailableText);
      return;
    }
    const result = runtime.dispatcher.execute(
      startExecuteRequest(
        {
          identityId: resolved.identityId,
          globalRoles: resolved.globalRoles,
        },
        "deepLink" in parsed ? parsed.deepLink : undefined,
      ),
    );
    switch (result.kind) {
      case "message":
        await ctx.reply(result.text);
        outcome = {
          level: "debug",
          message: "start reply sent",
          result: "ok",
          use_case: "start",
        };
        return;
      case "rejected":
        outcome = {
          level: "warn",
          message: "dispatcher rejected request",
          result: "error",
          use_case: "start",
          error_category: result.reason,
          error: result.reason,
        };
        return;
      default: {
        const _exhaustive: never = result;
        outcome = {
          level: "error",
          message: "unhandled dispatcher result",
          result: "error",
          use_case: "start",
          error_category: "unhandled_result",
          error: String(_exhaustive),
        };
      }
    }
  } catch (cause) {
    if (outcome === undefined) {
      outcome = unexpectedOutcome(cause);
    }
  } finally {
    if (outcome !== undefined) {
      writeBoundary(runtime.logger, ctx, outcome);
    }
  }
}

function unexpectedOutcome(
  cause: unknown,
  fallback?: unknown,
): BoundaryOutcome {
  const outcome: BoundaryOutcome = {
    level: "error",
    message: "update handler failed",
    result: "error",
    error_category: "unexpected",
    error: errorText(cause),
  };
  const stack = errorStack(cause) ?? errorStack(fallback);
  if (stack !== undefined) {
    outcome.stack = stack;
  }
  return outcome;
}

function writeBoundary(
  logger: Logger,
  ctx: UpdateContext,
  outcome: BoundaryOutcome,
): void {
  const fields: LogFields = {
    operation,
    result: outcome.result,
  };
  if (ctx.requestId !== undefined && ctx.requestId !== "") {
    fields.request_id = ctx.requestId;
  }
  if (ctx.startedAt !== undefined) {
    fields.duration_us = elapsedUs(ctx.startedAt);
  }
  if (outcome.use_case !== undefined) {
    fields.use_case = outcome.use_case;
  }
  if (outcome.result === "error") {
    fields.error_category = outcome.error_category;
    fields.error = outcome.error;
    if (outcome.stack !== undefined) {
      fields.stack = outcome.stack;
    }
  }
  logger[outcome.level](outcome.message, fields);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorStack(cause: unknown): string | undefined {
  if (
    cause instanceof Error &&
    cause.stack !== undefined &&
    cause.stack !== ""
  ) {
    return cause.stack;
  }
  return undefined;
}

function elapsedUs(started: bigint): number {
  return Number((process.hrtime.bigint() - started) / 1000n);
}
