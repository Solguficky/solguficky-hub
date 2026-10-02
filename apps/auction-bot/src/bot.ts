import { randomUUID } from "node:crypto";
import { Bot, type Context, GrammyError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { PortsFactory } from "./clients.js";
import type { TelegramEnvironment } from "./config.js";
import { type AuctionEntryScreen, renderEntryScreen } from "./entry-screen.js";
import type { FaqContent } from "./faq.js";
import type { LogFields, Logger } from "./logging.js";
import {
  type RouteOutcome,
  routeAuctionCallback,
  routeAuctionStart,
} from "./route.js";

export type BotOptions = {
  token: string;
  environment: TelegramEnvironment;
  ports: PortsFactory;
  logger: Logger;
  faq?: FaqContent;
  // Тесты передают его, чтобы не звать getMe.
  botInfo?: UserFromGetMe;
};

type UpdateContext = Context & { requestId: string; startedAt: bigint };

// Адаптер grammY: Telegram заканчивается здесь. Маршрут и оболочка Telegram
// не знают, бот хаба этот модуль не импортирует (ADR-044).
export function createBot(options: BotOptions): Bot<UpdateContext> {
  const bot = new Bot<UpdateContext>(options.token, {
    client: { environment: options.environment },
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  });
  const { logger } = options;

  bot.use((ctx, next) => {
    ctx.requestId = randomUUID();
    ctx.startedAt = process.hrtime.bigint();
    return next();
  });

  // Только личный чат: в группе бот аукциона молчит.
  const direct = bot.chatType("private");

  direct.command("start", async (ctx) => {
    const outcome = await routeAuctionStart({
      ports: options.ports(ctx.requestId),
      user: {
        telegramUserId: ctx.from.id,
        ...(ctx.from.username === undefined
          ? {}
          : { telegramUsername: ctx.from.username }),
      },
    });
    const screen = renderEntryScreen(outcome.screen, options.faq);
    await ctx.reply(screen.text, {
      reply_markup: { inline_keyboard: screen.keyboard.map((r) => [...r]) },
    });
    log({ logger, ctx, outcome, operation: "start" });
  });

  direct.on("callback_query:data", async (ctx) => {
    // Ответ на нажатие уходит до похода к соседям: иначе клиент крутит
    // индикатор, пока Identity и Auction отвечают.
    await ctx.answerCallbackQuery().catch((cause: unknown) => {
      logger.warn("answerCallbackQuery failed", {
        request_id: ctx.requestId,
        error: messageOf(cause),
      });
    });
    const outcome = await routeAuctionCallback({
      ports: options.ports(ctx.requestId),
      user: {
        telegramUserId: ctx.from.id,
        ...(ctx.from.username === undefined
          ? {}
          : { telegramUsername: ctx.from.username }),
      },
      data: ctx.callbackQuery.data,
    });
    const screen = renderEntryScreen(outcome.screen, options.faq);
    const markup = {
      reply_markup: { inline_keyboard: screen.keyboard.map((r) => [...r]) },
    };
    try {
      await ctx.editMessageText(screen.text, markup);
    } catch (cause) {
      if (!(cause instanceof GrammyError)) throw cause;
      // Тот же экран после повторного нажатия — не отказ.
      if (cause.description.includes("message is not modified")) {
        // ничего не показываем
      } else if (notEditable(cause.description)) {
        // Сообщение не редактируется — ответ уходит новым сообщением
        // (бриф ботов, «Правила края при отказах Telegram»).
        await ctx.reply(screen.text, markup);
      } else {
        throw cause;
      }
    } finally {
      log({ logger, ctx, outcome, operation: "callback" });
    }
  });

  bot.catch((failure) => {
    logger.error("update failed", {
      ...frame(failure.ctx, "update"),
      result: "error",
      error_category: "unexpected",
      error: messageOf(failure.error),
    });
  });

  return bot;
}

function frame(ctx: UpdateContext, operation: string): LogFields {
  return {
    operation,
    request_id: ctx.requestId,
    duration_us: Number((process.hrtime.bigint() - ctx.startedAt) / 1000n),
  };
}

// Исход экрана — в поле `screen`; `result` и класс отказа — по logging.md.
function log(input: {
  logger: Logger;
  ctx: UpdateContext;
  outcome: RouteOutcome;
  operation: "start" | "callback";
}): void {
  const { logger, ctx, outcome, operation } = input;
  const fields: LogFields = {
    ...frame(ctx, operation),
    screen: outcome.screen.kind,
    ...(outcome.identityId === undefined
      ? {}
      : { identity_id: outcome.identityId }),
  };
  if (outcome.failure !== undefined) {
    logger.error("update handled", {
      ...fields,
      result: "error",
      error_category: outcome.failure.category,
      error: outcome.failure.message,
      ...(outcome.failure.grpcCode === undefined
        ? {}
        : { grpc_code: outcome.failure.grpcCode }),
    });
    return;
  }
  const category = refusalCategory(outcome.screen);
  if (category === undefined) {
    logger.info("update handled", { ...fields, result: "ok" });
  } else {
    logger.info("update handled", {
      ...fields,
      result: "error",
      error_category: category,
    });
  }
}

function refusalCategory(
  screen: AuctionEntryScreen,
): "authorization" | "invariant" | undefined {
  switch (screen.kind) {
    case "denied":
      return "authorization";
    case "outdated":
      return "invariant";
    default:
      return undefined;
  }
}

function notEditable(description: string): boolean {
  return (
    description.includes("message can't be edited") ||
    description.includes("message to edit not found")
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
