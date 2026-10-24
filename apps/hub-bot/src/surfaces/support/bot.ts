import type { Bot } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { createBotShell, type ShellContext } from "../../core/bot/shell.js";
import { markUpdateFailed } from "../../core/bot/tracing.js";
import type { TelegramEnvironment } from "../../core/config.js";
import { carriesPersonContent } from "../../core/entry.js";
import { countFailure, type FailureCategory } from "../../core/failures.js";
import type { LogFields, Logger } from "../../core/logging.js";
import type { Tracing } from "../../core/tracing.js";
import { classifyRefusal, type TelegramRefusal } from "./failures.js";
import type { StandingPort } from "./identity.js";
import type { PairStore } from "./pairs.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import {
  blockedText,
  type CardCircle,
  cardText,
  notCopyableText,
  notDeliveredText,
  operatorRefusals,
  type Person,
  rateLimitText,
  type Source,
  topicName,
  welcomeText,
} from "./texts.js";

export type BotOptions = {
  token: string;
  environment: TelegramEnvironment;
  tracing: Tracing;
  logger: Logger;
  // Супергруппа операторов с темами (ADR-068, п. 4).
  groupId: number;
  // Пояс сообщества: в нём карточка темы пишет дату.
  timeZone: string;
  standing: StandingPort;
  // Хранилище пар открывается вместе с соединением шины, после сборки бота,
  // но до поллера (`surface.ts`): поэтому бот берёт его вызовом.
  pairs: () => PairStore;
  limiter?: RateLimiter;
  now?: () => Date;
  // Тесты передают его, чтобы не звать getMe.
  botInfo?: UserFromGetMe;
};

type UpdateContext = ShellContext;

// Реакция-квитанция: скопированное сообщение человека и доставленный ответ
// оператора. Других реакций бот не ставит.
const receipt = [{ type: "emoji", emoji: "👌" }] as const;

// Метку `?start=` бот помнит до первого сообщения человека, после рестарта
// источник неизвестен (дизайн-код, «Бот поддержки»). Предел — память процесса
// не растёт с числом тех, кто открыл бота и ничего не написал.
const sourceLimit = 10_000;

// Тема, заведённая без записанной пары, ждёт в памяти процесса следующего
// сообщения человека: бот дописывает её пару, а не заводит вторую тему. Тот
// же предел — память не растёт с числом сбоев KV. Рестарт тему забывает.
const unpairedLimit = 10_000;

type Unpaired = { thread: number; source: Source | undefined };

// Запись в отображение с пределом: самая старая уходит первой.
function remember<V>(
  map: Map<number, V>,
  key: number,
  value: V,
  limit: number,
) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// Текст после метки `/start` не читается: команда — приветствие, а не реплика.
const startCommand = /^\/start(?:@\S+)?(?:\s+(\S+))?(?:\s|$)/;

function sourceOf(payload: string | undefined): Source | undefined {
  return payload === "hub" || payload === "auction" ? payload : undefined;
}

// Что Telegram копировать не даёт: счёт, розыгрыш и его итог, платное медиа
// и викторина, правильного ответа которой бот не знает (Bot API,
// `copyMessage`). Отказ видно до вызова; остальное отсеивает ответ Telegram.
function knownUncopyable(message: Message): boolean {
  return (
    message.invoice !== undefined ||
    message.giveaway !== undefined ||
    message.giveaway_winners !== undefined ||
    message.paid_media !== undefined ||
    message.poll?.type === "quiz"
  );
}

// Прислал ли отправитель содержимое, а не служебное событие чата: тему
// создали, закрыли, человек вошёл в группу, закрепили сообщение.
function carriesContent(message: Message): boolean {
  return (
    carriesPersonContent(message) ||
    message.story !== undefined ||
    knownUncopyable(message)
  );
}

function personOf(user: NonNullable<Message["from"]>): Person {
  return {
    firstName: user.first_name,
    ...(user.last_name === undefined ? {} : { lastName: user.last_name }),
    ...(user.username === undefined ? {} : { username: user.username }),
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Адаптер grammY бота поддержки: у человека — переписка, у операторов — тема
// на человека в супергруппе (ADR-068). Экранов, меню и кнопок нет.
export function createBot(options: BotOptions): Bot<UpdateContext> {
  const bot = createBotShell<UpdateContext>({
    token: options.token,
    environment: options.environment,
    tracing: options.tracing,
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  });
  const { logger, groupId } = options;
  const limiter = options.limiter ?? createRateLimiter();
  const now = options.now ?? (() => new Date());
  const sources = new Map<number, Source>();
  const unpaired = new Map<number, Unpaired>();

  const frame = (ctx: UpdateContext, operation: string): LogFields => ({
    operation,
    request_id: ctx.requestId,
    duration_us: Number((process.hrtime.bigint() - ctx.startedAt) / 1000n),
  });

  const handled = (
    ctx: UpdateContext,
    operation: string,
    outcome: string,
    failure?: { category: FailureCategory; error?: string },
  ) => {
    if (failure === undefined) {
      logger.info("update handled", {
        ...frame(ctx, operation),
        result: "ok",
        outcome,
      });
      return;
    }
    countFailure(failure.category);
    markUpdateFailed(ctx.updateSpan, failure.category);
    logger.warn("update handled", {
      ...frame(ctx, operation),
      result: "error",
      outcome,
      error_category: failure.category,
      ...(failure.error === undefined ? {} : { error: failure.error }),
    });
  };

  // Отказ побочного вызова — реакции, карточки, переписи пары — пишется, но
  // реплику не роняет: сообщение уже дошло.
  const sideFailed = (
    ctx: UpdateContext,
    operation: string,
    cause: unknown,
  ) => {
    countFailure("dependency_unavailable");
    logger.warn("support side call failed", {
      ...frame(ctx, operation),
      result: "error",
      error_category: "dependency_unavailable",
      error: messageOf(cause),
    });
  };

  const attempt = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "ok" as const;
    } catch (cause) {
      return { refusal: classifyRefusal(cause), cause };
    }
  };

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (ctx.chat.type === "private") {
      await fromPerson(ctx, message);
      return;
    }
    if (ctx.chat.id === groupId) {
      await fromOperator(ctx, message);
    }
    // Чужие чаты бот не читает и не отвечает в них.
  });

  // Реплика человека: квитанция — реакция, текст — только при сбое, реплаем.
  async function fromPerson(ctx: UpdateContext, message: Message) {
    const user = message.from;
    if (user === undefined || user.is_bot) return;
    // Ответ на сбой сам может не дойти: тогда он пишется, а исход реплики
    // остаётся тем, что случилось с сообщением.
    const reply = async (text: string) => {
      try {
        await ctx.api.sendMessage(message.chat.id, text, {
          reply_parameters: {
            message_id: message.message_id,
            allow_sending_without_reply: true,
          },
        });
      } catch (cause) {
        sideFailed(ctx, "person_reply", cause);
      }
    };

    const start = message.text?.match(startCommand);
    if (start !== null && start !== undefined) {
      const source = sourceOf(start[1]);
      if (source !== undefined) {
        remember(sources, user.id, source, sourceLimit);
      }
      // Тему `/start` не заводит: его видит каждый, кто открыл бота.
      try {
        await ctx.api.sendMessage(message.chat.id, welcomeText, {
          parse_mode: "HTML",
        });
      } catch (cause) {
        handled(ctx, "start", "welcome-not-sent", {
          category: "dependency_unavailable",
          error: messageOf(cause),
        });
        return;
      }
      handled(ctx, "start", "welcome");
      return;
    }
    if (!carriesContent(message)) return;

    const admission = limiter.admit(user.id);
    if (admission === "drop") {
      handled(ctx, "person", "rate-limited");
      return;
    }
    if (admission === "notify") {
      await reply(rateLimitText);
      handled(ctx, "person", "rate-limited");
      return;
    }
    if (knownUncopyable(message)) {
      await reply(notCopyableText);
      handled(ctx, "person", "not-copyable");
      return;
    }

    // Identity недоступен — сообщение всё равно уходит операторам, а
    // карточка говорит «круг неизвестен» (ADR-068, п. 3).
    let circle: CardCircle;
    try {
      const standing = await options.standing.resolve(
        {
          telegramId: user.id,
          ...(user.username === undefined ? {} : { username: user.username }),
        },
        ctx.requestId,
      );
      if (standing.blocked) {
        try {
          await ctx.api.sendMessage(message.chat.id, blockedText, {
            parse_mode: "HTML",
          });
        } catch (cause) {
          sideFailed(ctx, "person_reply", cause);
        }
        handled(ctx, "person", "blocked", { category: "authorization" });
        return;
      }
      circle = standing.circle;
    } catch (cause) {
      sideFailed(ctx, "resolve_identity", cause);
      circle = "unknown";
    }

    const notDelivered = async (outcome: string, cause: unknown) => {
      await reply(notDeliveredText);
      handled(ctx, "person", outcome, {
        category: "dependency_unavailable",
        error: messageOf(cause),
      });
    };

    // Метку источника бот помнит до первого сообщения, а не до темы: иначе
    // она пережила бы месяцы переписки и попала в карточку темы, заведённой
    // взамен удалённой.
    let source = sources.get(user.id);
    sources.delete(user.id);

    let pairs: PairStore;
    let thread: number | undefined;
    try {
      pairs = options.pairs();
      thread = await pairs.threadOf(user.id);
    } catch (cause) {
      await notDelivered("store-unavailable", cause);
      return;
    }
    // Пара на месте — забытая тема больше не нужна.
    if (thread !== undefined) unpaired.delete(user.id);

    // Новая тема: сначала пара, потом карточка и копия (ADR-068, п. 8).
    // Карточка — снимок на момент заведения темы. Тема, чья пара не
    // записалась, заводится один раз: дальше бот дописывает её пару, а
    // карточку и метку источника она получает вместе с парой.
    const openTopic = async (): Promise<
      { thread: number; reused: boolean } | { cause: unknown }
    > => {
      const waiting = unpaired.get(user.id);
      let opened: number;
      if (waiting === undefined) {
        try {
          const topic = await ctx.api.createForumTopic(
            groupId,
            topicName(personOf(user)),
          );
          opened = topic.message_thread_id;
        } catch (cause) {
          return { cause };
        }
      } else {
        opened = waiting.thread;
        source = waiting.source ?? source;
      }
      try {
        await pairs.bind(user.id, opened);
      } catch (cause) {
        remember(unpaired, user.id, { thread: opened, source }, unpairedLimit);
        return { cause };
      }
      unpaired.delete(user.id);
      try {
        await ctx.api.sendMessage(
          groupId,
          cardText({
            person: personOf(user),
            circle,
            source,
            at: now(),
            timeZone: options.timeZone,
          }),
          { message_thread_id: opened },
        );
      } catch (cause) {
        sideFailed(ctx, "topic_card", cause);
      }
      return { thread: opened, reused: waiting !== undefined };
    };

    let fresh = false;
    // Тему, заведённую раньше без пары, оператор мог успеть удалить.
    let reused = false;
    if (thread === undefined) {
      const opened = await openTopic();
      if ("cause" in opened) {
        await notDelivered("topic-not-opened", opened.cause);
        return;
      }
      thread = opened.thread;
      fresh = true;
      reused = opened.reused;
    }

    const copyInto = (into: number) =>
      attempt(() =>
        ctx.api.copyMessage(groupId, message.chat.id, message.message_id, {
          message_thread_id: into,
        }),
      );

    let copied = await copyInto(thread);
    // Закрытую тему бот открывает снова (ADR-068, п. 5).
    if (copied !== "ok" && copied.refusal === "topic-closed") {
      const target = thread;
      const reopened = await attempt(() =>
        ctx.api.reopenForumTopic(groupId, target),
      );
      copied = reopened === "ok" ? await copyInto(target) : reopened;
    }
    // Удалённая тема снимает пару, и бот заводит новую — один раз.
    if (
      copied !== "ok" &&
      copied.refusal === "topic-missing" &&
      (!fresh || reused)
    ) {
      try {
        await pairs.unbind(user.id, thread);
      } catch (cause) {
        sideFailed(ctx, "unbind_pair", cause);
      }
      const opened = await openTopic();
      if ("cause" in opened) {
        await notDelivered("topic-not-opened", opened.cause);
        return;
      }
      thread = opened.thread;
      fresh = true;
      copied = await copyInto(thread);
    }
    if (copied !== "ok") {
      if (copied.refusal === "not-copyable") {
        await reply(notCopyableText);
        handled(ctx, "person", "not-copyable");
        return;
      }
      await notDelivered(`copy-${copied.refusal}`, copied.cause);
      return;
    }

    // Сообщение человека переписывает обе записи пары: срок считается от
    // последнего сообщения в теме. Новая пара только что записана.
    if (!fresh) {
      const touched = thread;
      try {
        await pairs.bind(user.id, touched);
      } catch (cause) {
        sideFailed(ctx, "touch_pair", cause);
      }
    }
    try {
      await ctx.api.setMessageReaction(message.chat.id, message.message_id, [
        ...receipt,
      ]);
    } catch (cause) {
      sideFailed(ctx, "receipt", cause);
    }
    handled(ctx, "person", fresh ? "copied-new-topic" : "copied");
  }

  // Ответ оператора: любое сообщение в теме, кроме заметки `//`, уходит
  // человеку копией от имени бота (ADR-068, п. 6).
  async function fromOperator(ctx: UpdateContext, message: Message) {
    const thread = message.message_thread_id;
    // Общую тему группы бот не читает.
    if (message.is_topic_message !== true || thread === undefined) return;
    if (!carriesContent(message)) return;
    // Анонимный администратор пишет от имени группы, а `from` у него — бот
    // GroupAnonymousBot: поэтому проверка группы идёт раньше отсева ботов.
    const anonymous = message.sender_chat?.id === groupId;
    if (!anonymous) {
      if (message.sender_chat !== undefined) return;
      if (message.from === undefined || message.from.is_bot) return;
    }
    const said = message.text ?? message.caption ?? "";
    if (said.startsWith("//")) return;

    const answer = async (
      text: string,
      outcome: string,
      failure?: { category: FailureCategory; error?: string },
    ) => {
      try {
        await ctx.api.sendMessage(groupId, text, {
          message_thread_id: thread,
          reply_parameters: {
            message_id: message.message_id,
            allow_sending_without_reply: true,
          },
        });
      } catch (cause) {
        sideFailed(ctx, "operator_refusal", cause);
      }
      handled(ctx, "operator", outcome, failure);
    };

    let pairs: PairStore;
    let person: number | undefined;
    try {
      pairs = options.pairs();
      person = await pairs.personOf(thread);
    } catch (cause) {
      await answer(operatorRefusals.unavailable, "store-unavailable", {
        category: "dependency_unavailable",
        error: messageOf(cause),
      });
      return;
    }
    if (person === undefined) {
      await answer(operatorRefusals.unpaired, "unpaired", {
        category: "invariant",
      });
      return;
    }
    const recipient = person;
    const copied = await attempt(() =>
      ctx.api.copyMessage(recipient, groupId, message.message_id),
    );
    if (copied !== "ok") {
      const stopped = copied.refusal === "stopped";
      await answer(
        stopped ? operatorRefusals.stopped : operatorRefusals.rejected,
        `copy-${copied.refusal satisfies TelegramRefusal}`,
        // Человек, остановивший бота, — его выбор, а не сбой.
        stopped
          ? undefined
          : {
              category: "dependency_unavailable",
              error: messageOf(copied.cause),
            },
      );
      return;
    }
    try {
      await ctx.api.setMessageReaction(groupId, message.message_id, [
        ...receipt,
      ]);
    } catch (cause) {
      sideFailed(ctx, "receipt", cause);
    }
    // Доставленный ответ тоже продлевает пару, но только текущую тему
    // человека. Тема, оставшаяся от сбоя между двумя записями новой пары,
    // отвечает человеку, но его к себе не возвращает: иначе каждый ответ в
    // старой и новой теме перекидывал бы его сообщения между ними.
    try {
      if ((await pairs.threadOf(recipient)) === thread) {
        await pairs.bind(recipient, thread);
      }
    } catch (cause) {
      sideFailed(ctx, "touch_pair", cause);
    }
    handled(ctx, "operator", "delivered");
  }

  bot.catch((failure) => {
    countFailure("unexpected");
    logger.error("update failed", {
      ...frame(failure.ctx, "update"),
      result: "error",
      error_category: "unexpected",
      error: messageOf(failure.error),
    });
  });

  return bot;
}
