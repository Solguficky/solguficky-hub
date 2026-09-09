import { randomUUID } from "node:crypto";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { Dispatcher } from "../application/dispatcher.js";
import { formatSchedule } from "../application/meetup-form.js";
import type { FormField, Person } from "../application/types.js";
import { startExecuteRequest } from "../application/types.js";
import {
  type IdentityResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import type { MeetupSummary } from "../meetups/port.js";
import { parseCallback } from "./parse-callback.js";
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
const questionTtlMs = 60 * 60 * 1_000;
const questionLimit = 1_000;

type PendingQuestion = {
  field: FormField;
  meetupId: string;
  telegramUserId: number;
  expiresAt: number;
};

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
      grpc_code?: string;
      reply_error?: string;
    };

export function createBot(runtime: BotRuntime): Bot<UpdateContext> {
  const bot = new Bot<UpdateContext>(runtime.token);
  const questions = new Map<string, PendingQuestion>();
  bot.use((ctx, next) => {
    ctx.requestId = randomUUID();
    ctx.startedAt = process.hrtime.bigint();
    return next();
  });
  bot.on("callback_query:data", (ctx) =>
    handleCallback(ctx, runtime, questions),
  );
  bot.on("message", (ctx) => handleMessage(ctx, runtime, questions));
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
  questions: Map<string, PendingQuestion>,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  try {
    const replyId = ctx.message?.reply_to_message?.message_id;
    removeExpiredQuestions(questions, Date.now());
    const pending =
      replyId === undefined
        ? undefined
        : questions.get(questionKey(ctx.chat?.id, replyId));
    if (
      replyId !== undefined &&
      pending !== undefined &&
      ctx.message?.text !== undefined
    ) {
      if (ctx.from?.id !== pending.telegramUserId) {
        return;
      }
      const person = await resolvePerson(ctx, runtime);
      if (person === undefined) return;
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-meetup-field",
        field: pending.field,
        value: ctx.message.text,
        meetupId: pending.meetupId,
        ...requestId(ctx),
      });
      questions.delete(questionKey(ctx.chat?.id, replyId));
      await renderFormResult(ctx, result, questions);
      outcome = {
        level: "debug",
        message: "meetup form answer handled",
        result: "ok",
        use_case: "create_meetup",
      };
      return;
    }
    if (
      replyId !== undefined &&
      ctx.message?.reply_to_message?.from?.id === ctx.me.id
    ) {
      await ctx.reply(
        "Этот вопрос уже устарел. Открой управление сходками и продолжи с актуального экрана.",
      );
      outcome = {
        level: "debug",
        message: "stale form answer handled",
        result: "ok",
        use_case: "create_meetup",
      };
      return;
    }
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
      ctx.requestId,
    );
    if (resolved.kind !== "resolved") {
      outcome = await replyFailClosed(ctx, identityFailureOutcome(resolved));
      return;
    }
    const result = await runtime.dispatcher.execute(
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
        await ctx.reply(result.text, {
          reply_markup: new InlineKeyboard()
            .text("Ближайшие сходки", "v1:nav:hub")
            .row()
            .text("Управление сходками", "v1:manage:menu"),
        });
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
      case "ask":
      case "preview":
      case "published":
      case "dependency-rejected":
      case "meetup-list":
        outcome = {
          level: "error",
          message: "unexpected form result",
          result: "error",
          use_case: "start",
          error_category: "unhandled_result",
          error: result.kind,
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

async function handleCallback(
  ctx: UpdateContext,
  runtime: BotRuntime,
  questions: Map<string, PendingQuestion>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const action = parseCallback(ctx.callbackQuery?.data);
  if (action.kind === "outdated" || action.kind === "malformed") {
    await ctx.reply("Этот экран устарел. Открой актуальное меню через /start.");
    return;
  }
  const person = await resolvePerson(ctx, runtime);
  if (person === undefined) return;
  if (action.kind === "hub") {
    const result = await runtime.dispatcher.execute({
      identity: person,
      intent: "list-visible-meetups",
      ...requestId(ctx),
    });
    await renderMeetupList(ctx, result);
    return;
  }
  if (action.kind === "manage-menu") {
    const id = createUuidV7();
    await ctx.reply("Управление сходками", {
      reply_markup: new InlineKeyboard().text(
        "Создать сходку",
        `v1:manage:new:${uuidToToken(id)}`,
      ),
    });
    return;
  }
  if (action.kind === "create-meetup") {
    const result = await runtime.dispatcher.execute({
      identity: person,
      intent: "create-meetup",
      meetupId: tokenToUuid(action.token),
      ...requestId(ctx),
    });
    await renderFormResult(ctx, result, questions);
    return;
  }
  if (action.kind === "publish-meetup") {
    const result = await runtime.dispatcher.execute({
      identity: person,
      intent: "publish-meetup",
      meetupId: tokenToUuid(action.token),
      ...requestId(ctx),
    });
    await renderFormResult(ctx, result, questions);
    return;
  }
}

async function renderMeetupList(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
): Promise<void> {
  if (result.kind === "meetup-list") {
    const keyboard = meetupListKeyboard(result.meetups);
    const text =
      result.meetups.length === 0
        ? `Пока ни одной запланированной сходки нет.\n\nКогда организатор создаст новую, она появится здесь.`
        : meetupListText(result.meetups);
    await editScreen(ctx, text, keyboard);
    return;
  }
  if (result.kind === "dependency-rejected") {
    await editScreen(
      ctx,
      `Не получилось загрузить сходки. Это на моей стороне.\n\nПопробуй ещё раз через минуту.`,
      new InlineKeyboard().text("Повторить", "v1:nav:hub"),
    );
  }
}

async function editScreen(
  ctx: UpdateContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (cause) {
    if (errorText(cause).includes("message is not modified")) {
      return;
    }
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

function meetupListText(meetups: readonly MeetupSummary[]): string {
  const dated = meetups.some((meetup) => meetup.schedule !== undefined);
  const undated = meetups.some((meetup) => meetup.schedule === undefined);
  return [
    "Ближайшие сходки",
    dated ? "С датой" : undefined,
    undated ? "Без даты" : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n\n");
}

function meetupListKeyboard(meetups: readonly MeetupSummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const dated = meetups.filter((meetup) => meetup.schedule !== undefined);
  const undated = meetups.filter((meetup) => meetup.schedule === undefined);
  for (const meetup of [...dated, ...undated]) {
    keyboard
      .text(
        meetupButtonText(meetup),
        `v1:meetup:view:${uuidToToken(meetup.id)}`,
      )
      .row();
  }
  return keyboard.text("Обновить", "v1:nav:hub");
}

function meetupButtonText(meetup: MeetupSummary): string {
  if (meetup.schedule === undefined) {
    return `Без даты — ${meetup.title}`;
  }
  const { year, month, day } = meetup.schedule;
  const date = new Date(Date.UTC(year, month - 1, day));
  const monthLabel = new Intl.DateTimeFormat("ru-RU", {
    month: "short",
    timeZone: "UTC",
  })
    .format(date)
    .replaceAll(".", "");
  const weekdayLabel = new Intl.DateTimeFormat("ru-RU", {
    weekday: "short",
    timeZone: "UTC",
  })
    .format(date)
    .replaceAll(".", "");
  return `${day} ${monthLabel}, ${weekdayLabel} — ${meetup.title}`;
}

async function resolvePerson(
  ctx: UpdateContext,
  runtime: BotRuntime,
): Promise<Person | undefined> {
  const from = ctx.from;
  if (from === undefined) return undefined;
  const resolved = await runtime.identity.resolve(
    toResolveIdentityInput(BigInt(from.id), from.username),
    ctx.requestId,
  );
  if (resolved.kind !== "resolved") {
    await ctx.reply(unavailableText);
    return undefined;
  }
  return { identityId: resolved.identityId, globalRoles: resolved.globalRoles };
}

async function renderFormResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  questions: Map<string, PendingQuestion>,
): Promise<void> {
  if (result.kind === "ask") {
    const prompts: Record<FormField, string> = {
      title: "Как называется сходка?",
      schedule: "Когда встречаемся? Напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ",
      venue: "Где встречаемся?",
      description: "Добавь короткое описание сходки.",
    };
    const message = await ctx.reply(result.error ?? prompts[result.field], {
      reply_markup: { force_reply: true, selective: true },
    });
    questions.set(questionKey(ctx.chat?.id, message.message_id), {
      field: result.field,
      meetupId: result.meetup.id,
      telegramUserId: ctx.from?.id ?? 0,
      expiresAt: Date.now() + questionTtlMs,
    });
    evictOldestQuestions(questions);
    return;
  }
  if (result.kind === "preview") {
    const meetup = result.meetup;
    await ctx.reply(
      `Проверь сходку\n\n${meetup.title}\n${formatSchedule(meetup)}\n${meetup.venue}\n\n${meetup.description}`,
      {
        reply_markup: new InlineKeyboard().text(
          "Опубликовать",
          `v1:manage:publish:${uuidToToken(meetup.id)}`,
        ),
      },
    );
    return;
  }
  if (result.kind === "published") {
    await ctx.reply(`Сходка опубликована: ${result.meetup.title}`);
    return;
  }
  if (result.kind === "dependency-rejected") {
    if (result.reason === "invalid") {
      await ctx.reply(`Не получилось сохранить значение: ${result.message}`);
      return;
    }
    await ctx.reply(
      result.reason === "forbidden"
        ? "Meetups не разрешил это действие."
        : unavailableText,
    );
  }
}

function removeExpiredQuestions(
  questions: Map<string, PendingQuestion>,
  now: number,
): void {
  for (const [key, question] of questions) {
    if (question.expiresAt <= now) questions.delete(key);
  }
}

function evictOldestQuestions(questions: Map<string, PendingQuestion>): void {
  while (questions.size > questionLimit) {
    const oldest = questions.keys().next().value;
    if (oldest === undefined) return;
    questions.delete(oldest);
  }
}

function createUuidV7(): string {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToToken(id: string): string {
  return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url");
}
function requestId(ctx: UpdateContext): { requestId?: string } {
  return ctx.requestId === undefined ? {} : { requestId: ctx.requestId };
}
function questionKey(chatId: number | undefined, messageId: number): string {
  return `${chatId ?? "unknown"}:${messageId}`;
}
function tokenToUuid(token: string): string {
  const hex = Buffer.from(token, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Недоступность зависимости и отвергнутый ею вызов — разные отказы: первый
// проходит по повтору, второй никогда. Человеку в обоих случаях уходит один и
// тот же fail-closed ответ, различие живёт в записи границы.
function identityFailureOutcome(
  resolved:
    | { kind: "unavailable"; cause: unknown }
    | { kind: "rejected"; code: string; cause: unknown },
): BoundaryOutcome {
  if (resolved.kind === "rejected") {
    return {
      level: "error",
      message: "identity rejected the request",
      result: "error",
      use_case: "start",
      error_category: "identity_rejected",
      grpc_code: resolved.code,
      error: errorText(resolved.cause),
    };
  }
  return {
    level: "error",
    message: "identity unavailable",
    result: "error",
    use_case: "start",
    error_category: "identity_unavailable",
    error: errorText(resolved.cause),
  };
}

// Отказ самого ответа человеку нельзя терять: раньше outcome присваивался до
// await, поэтому catch видел его непустым и 403 от Bot API не попадал ни в
// запись границы, ни в bot.catch.
async function replyFailClosed(
  ctx: UpdateContext,
  outcome: BoundaryOutcome,
): Promise<BoundaryOutcome> {
  try {
    await ctx.reply(unavailableText);
    return outcome;
  } catch (cause) {
    if (outcome.result === "error") {
      return { ...outcome, reply_error: errorText(cause) };
    }
    return outcome;
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
    if (outcome.grpc_code !== undefined) {
      fields.grpc_code = outcome.grpc_code;
    }
    if (outcome.reply_error !== undefined) {
      fields.reply_error = outcome.reply_error;
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
