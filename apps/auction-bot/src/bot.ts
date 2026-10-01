import { randomUUID } from "node:crypto";
import { Bot, type Context, GrammyError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { PortsFactory } from "./clients.js";
import type { TelegramEnvironment } from "./config.js";
import { renderEntryScreen } from "./entry-screen.js";
import type { Logger } from "./logging.js";
import { routeAuctionCallback } from "./route.js";

export type BotOptions = {
  token: string;
  environment: TelegramEnvironment;
  ports: PortsFactory;
  logger: Logger;
  // Тесты передают его, чтобы не звать getMe.
  botInfo?: UserFromGetMe;
};

type UpdateContext = Context & { requestId: string };

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
    return next();
  });

  // Только личный чат: в группе бот аукциона молчит.
  const direct = bot.chatType("private");

  direct.command("start", async (ctx) => {
    const screen = renderEntryScreen({ kind: "welcome" });
    await ctx.reply(screen.text);
    logger.info("update handled", {
      operation: "start",
      result: "welcome",
      request_id: ctx.requestId,
    });
  });

  direct.on("callback_query:data", async (ctx) => {
    // Ответ на нажатие уходит до похода к соседям: иначе клиент крутит
    // индикатор, пока Identity и Auction отвечают.
    await ctx.answerCallbackQuery().catch((cause: unknown) => {
      logger.warn("answerCallbackQuery failed", {
        request_id: ctx.requestId,
        error: describe(cause),
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
    const fields = {
      operation: "callback",
      result: outcome.screen.kind,
      request_id: ctx.requestId,
      ...(outcome.identityId === undefined
        ? {}
        : { identity_id: outcome.identityId }),
    };
    if (outcome.failure === undefined) {
      logger.info("update handled", fields);
    } else {
      logger.error("dependency unavailable", {
        ...fields,
        error: describe(outcome.failure),
      });
    }
    const screen = renderEntryScreen(outcome.screen);
    try {
      await ctx.editMessageText(screen.text, {
        reply_markup: { inline_keyboard: screen.keyboard.map((r) => [...r]) },
      });
    } catch (cause) {
      // Тот же экран после повторного нажатия — не отказ.
      if (
        cause instanceof GrammyError &&
        cause.description.includes("message is not modified")
      ) {
        return;
      }
      logger.warn("editMessageText failed", {
        request_id: ctx.requestId,
        error: describe(cause),
      });
    }
  });

  bot.catch((failure) => {
    logger.error("update failed", {
      request_id: failure.ctx.requestId,
      error: describe(failure.error),
    });
  });

  return bot;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
