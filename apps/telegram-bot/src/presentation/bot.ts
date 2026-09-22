import { randomUUID } from "node:crypto";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { Dispatcher } from "../application/dispatcher.js";
import {
  decideHubAccess,
  type HubAccess,
  hubAccessErrors,
  hubAccessTexts,
} from "../application/hub-access.js";
import { formatSchedule } from "../application/meetup-form.js";
import type { ExecuteResult, FormField, Person } from "../application/types.js";
import { startExecuteRequest } from "../application/types.js";
import { countFailure, type FailureCategory } from "../failures.js";
import {
  type CommunityAdministrator,
  type IdentityAdminResult,
  type IdentityResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import type { MeetupSnapshot, MeetupSummary } from "../meetups/port.js";
import type { RpcMetadata } from "../rpc-metadata.js";
import { editQuestionText, parseEditQuestion } from "./edit-question.js";
import {
  meetupStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { parseCallback, removableUsernamePattern } from "./parse-callback.js";
import { parseUpdate } from "./parse-update.js";

// Среда Telegram: `test` уводит вызовы Bot API на выделенную тестовую
// инфраструктуру (ADR-046). Значения совпадают с опцией grammY, чтобы между
// переменной окружения и клиентом не появилось второго словаря.
export type TelegramEnvironment = "prod" | "test";

export type BotRuntime = {
  token: string;
  dispatcher: Dispatcher;
  identity: IdentityResolver & Partial<CommunityAdministrator>;
  logger: Logger;
  presentation?: "rich" | "plain";
  environment?: TelegramEnvironment;
};

export const defaultTelegramEnvironment: TelegramEnvironment = "prod";

/**
 * Разбирает значение `TELEGRAM_BOT_ENVIRONMENT`. Отсутствие переменной — это
 * продакшн; любое неизвестное значение — `undefined`, а не молчаливый откат к
 * умолчанию: опечатка в переменной должна останавливать процесс, а не уводить
 * его в другую среду.
 */
export function parseTelegramEnvironment(
  raw: string | undefined,
): TelegramEnvironment | undefined {
  if (raw === undefined || raw === "") {
    return defaultTelegramEnvironment;
  }
  return raw === "prod" || raw === "test" ? raw : undefined;
}

const unavailableText = `Не получилось загрузить данные. Это на моей стороне.

Попробуй ещё раз через минуту.`;

const formPrompts: Record<FormField, string> = {
  title: "Как называется сходка?",
  schedule: "Когда встречаемся? Напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ",
  venue: "Где встречаемся?",
  description: "Добавь короткое описание сходки.",
};

// Отказ по конфликту версий закреплён решением PER-78 и повторяется здесь
// дословно: человеку нужно увидеть, что его ввод не сохранён, а не догадываться
// об этом по общему тексту сбоя.
const conflictText =
  "Сходка уже изменилась. Ваши изменения не сохранены. Проверьте актуальные данные и повторите.";
type ProductUseCase =
  | "create_meetup"
  | "update_meetup"
  | "find_meetup"
  | "view_meetup"
  | "manage_community";
const questionTtlMs = 60 * 60 * 1_000;
const questionLimit = 1_000;

type PendingQuestion = {
  kind: "meetup";
  mode: "create" | "edit";
  field: FormField;
  meetupId: string;
  telegramUserId: number;
  expiresAt: number;
};
type PendingUsername = {
  kind: "allowed-username";
  telegramUserId: number;
  expiresAt: number;
};
type PendingInput = PendingQuestion | PendingUsername;

type UpdateContext = Context & {
  requestId?: string;
  startedAt?: bigint;
};

type BoundaryOutcome =
  | {
      level: "debug";
      message: string;
      result: "ok";
      use_case?: ProductUseCase;
      meetup_id?: string;
      identity_id?: string;
    }
  | {
      level: "warn" | "error";
      message: string;
      result: "error";
      use_case?: ProductUseCase;
      meetup_id?: string;
      identity_id?: string;
      error_category: FailureCategory;
      error: string;
      stack?: string;
      grpc_code?: string;
      reply_error?: string;
    };

export function createBot(runtime: BotRuntime): Bot<UpdateContext> {
  // Среда передаётся всегда, а не только для `test`: умолчание живёт в одном
  // месте, и отсутствие поля не читается как «grammY решит сам».
  const bot = new Bot<UpdateContext>(runtime.token, {
    client: { environment: runtime.environment ?? defaultTelegramEnvironment },
  });
  const questions = new Map<string, PendingInput>();
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
  questions: Map<string, PendingInput>,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  try {
    const replyId = ctx.message?.reply_to_message?.message_id;
    removeExpiredQuestions(questions, Date.now());
    const storedPending =
      replyId === undefined
        ? undefined
        : questions.get(questionKey(ctx.chat?.id, replyId));
    const repliedMessage = ctx.message?.reply_to_message;
    const repliedText =
      repliedMessage !== undefined && "text" in repliedMessage
        ? repliedMessage.text
        : undefined;
    const recoveredEdit =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? parseEditQuestion(repliedText)
        : undefined;
    const pending =
      storedPending ??
      (recoveredEdit === undefined
        ? undefined
        : {
            kind: "meetup" as const,
            mode: "edit" as const,
            field: recoveredEdit.field,
            meetupId: tokenToUuid(recoveredEdit.token),
            telegramUserId: ctx.from?.id ?? 0,
            expiresAt: Date.now() + questionTtlMs,
          });
    if (
      replyId !== undefined &&
      pending !== undefined &&
      ctx.message?.text !== undefined
    ) {
      useCase =
        pending.kind === "allowed-username"
          ? "manage_community"
          : pending.mode === "edit"
            ? "update_meetup"
            : "create_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "debug",
          message: "foreign form answer ignored",
          result: "ok",
          use_case: useCase,
        };
        return;
      }
      if (pending.kind === "allowed-username") {
        useCase = "manage_community";
        const identity = await resolvePerson(ctx, runtime, useCase);
        if (identity.kind === "failed") {
          outcome = identity.outcome;
          return;
        }
        const result =
          runtime.identity.addAllowedUsername === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.addAllowedUsername(
                identity.person,
                ctx.message.text,
                rpcCall(ctx, useCase),
              );
        questions.delete(questionKey(ctx.chat?.id, replyId));
        await renderCommunity(
          ctx,
          runtime,
          identity.person,
          false,
          result.kind === "ok"
            ? result.value
              ? "Ник добавлен."
              : "Этот ник уже есть в списке."
            : result.kind === "invalid"
              ? "Это не похоже на ник Telegram. Пришли его ещё раз."
              : undefined,
        );
        outcome = adminOutcome(result, identity.person.identityId);
        return;
      }
      const identity = await resolvePerson(ctx, runtime, useCase);
      if (identity.kind === "failed") {
        outcome = identity.outcome;
        return;
      }
      const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, false);
      if (denied !== undefined) {
        outcome = denied;
        return;
      }
      const result = await runtime.dispatcher.execute({
        identity: identity.person,
        intent:
          pending.mode === "edit" ? "update-meetup-field" : "set-meetup-field",
        field: pending.field,
        value: ctx.message.text,
        meetupId: pending.meetupId,
        ...rpcCall(ctx, useCase),
      });
      questions.delete(questionKey(ctx.chat?.id, replyId));
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
      outcome = screenBoundary(result, {
        ok: [
          "ask",
          "edit-ask",
          "preview",
          "published",
          "meetup-updated",
          "edit-unavailable",
        ],
        okMessage: "meetup form answer handled",
        rejectedMessage: "meetup form answer rejected",
        useCase,
        meetupId: pending.meetupId,
      });
      return;
    }
    if (
      replyId !== undefined &&
      ctx.message?.reply_to_message?.from?.id === ctx.me.id
    ) {
      useCase = "create_meetup";
      await ctx.reply(
        "Этот вопрос уже устарел. Открой актуальное меню и повтори действие.",
      );
      outcome = {
        level: "debug",
        message: "stale form answer handled",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    const parsed = parseUpdate(ctx.update, ctx.me.username);
    if (parsed.kind === "malformed") {
      outcome = {
        level: "warn",
        message: "malformed telegram update",
        result: "error",
        error_category: "invariant",
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
    const deepLink = "deepLink" in parsed ? parsed.deepLink : undefined;
    useCase = deepLink?.kind === "meetup" ? "view_meetup" : "find_meetup";
    const resolved = await runtime.identity.resolve(
      toResolveIdentityInput(parsed.telegramUserId, parsed.telegramUsername),
      rpcCall(ctx, useCase),
    );
    if (resolved.kind !== "resolved") {
      outcome = await replyFailClosed(
        ctx,
        identityFailureOutcome(resolved, useCase),
      );
      return;
    }
    const identity = {
      identityId: resolved.identityId,
      globalRoles: resolved.globalRoles,
    };
    const denied = await denyHubAccessIfNeeded(
      ctx,
      { person: identity, blocked: resolved.blocked },
      useCase,
      false,
    );
    if (denied !== undefined) {
      outcome = denied;
      return;
    }
    const result = await runtime.dispatcher.execute(
      deepLink?.kind === "meetup"
        ? {
            identity,
            intent: "view-meetup",
            meetupId: tokenToUuid(deepLink.payload.slice(2)),
            ...rpcCall(ctx, "view_meetup"),
          }
        : startExecuteRequest(identity, deepLink),
    );
    if (
      result.kind === "meetup-card" ||
      result.kind === "meetup-not-found" ||
      result.kind === "dependency-rejected" ||
      result.kind === "rejected"
    ) {
      await renderMeetupCard(
        ctx,
        result,
        false,
        runtime.presentation ?? "rich",
        identity.globalRoles.includes("admin"),
      );
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup card sent",
        rejectedMessage: "meetup card rejected",
        useCase,
      });
      return;
    }
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
          use_case: "find_meetup",
        };
        return;
      case "ask":
      case "edit-ask":
      case "preview":
      case "published":
      case "meetup-updated":
      case "meetup-state-changed":
      case "meetup-state-unchanged":
      case "edit-unavailable":
      case "conflict":
      case "meetup-list":
        outcome = {
          level: "error",
          message: "unexpected form result",
          result: "error",
          use_case: "find_meetup",
          error_category: "unexpected",
          error: result.kind,
        };
        return;
      default: {
        const _exhaustive: never = result;
        outcome = {
          level: "error",
          message: "unhandled dispatcher result",
          result: "error",
          use_case: "find_meetup",
          error_category: "unexpected",
          error: String(_exhaustive),
        };
      }
    }
  } catch (cause) {
    if (outcome === undefined) {
      outcome = unexpectedOutcome(cause, undefined, useCase);
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
  questions: Map<string, PendingInput>,
): Promise<void> {
  let outcome: BoundaryOutcome | undefined;
  let useCase: ProductUseCase | undefined;
  try {
    // Разбор чистый и синхронный, поэтому он идёт до подтверждения: ack ничего
    // не ждёт, а его собственный отказ попадает в запись уже со сценарием.
    const action = parseCallback(ctx.callbackQuery?.data);
    if (action.kind === "malformed") {
      outcome = {
        level: "warn",
        message: "malformed callback data",
        result: "error",
        error_category: "invariant",
        error: "callback data failed validation",
      };
      await ctx.answerCallbackQuery();
      await editScreen(
        ctx,
        "Не получилось прочитать эту кнопку. Открой актуальное меню.",
        new InlineKeyboard().text("К списку", "v1:nav:hub"),
      );
      return;
    }
    useCase = callbackUseCase(action.kind);
    await ctx.answerCallbackQuery();
    const retryCallback =
      action.kind === "outdated"
        ? "v1:nav:hub"
        : (ctx.callbackQuery?.data ?? "v1:nav:hub");
    const identity = await resolvePerson(ctx, runtime, useCase, retryCallback);
    if (identity.kind === "failed") {
      outcome = identity.outcome;
      return;
    }
    const denied = await denyHubAccessIfNeeded(ctx, identity, useCase, true);
    if (denied !== undefined) {
      outcome = denied;
      return;
    }
    const person = identity.person;
    if (action.kind === "community") {
      const result = await renderCommunity(ctx, runtime, person, true);
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "ask-allowed-username") {
      const message = await ctx.reply(
        "Какой ник разрешить? Отправь его с @ или без.",
        { reply_markup: { force_reply: true, selective: true } },
      );
      questions.set(questionKey(ctx.chat?.id, message.message_id), {
        kind: "allowed-username",
        telegramUserId: ctx.from?.id ?? 0,
        expiresAt: Date.now() + questionTtlMs,
      });
      evictOldestQuestions(questions);
      outcome = {
        level: "debug",
        message: "allowed username requested",
        result: "ok",
        use_case: "manage_community",
        identity_id: person.identityId,
      };
      return;
    }
    if (
      action.kind === "admit-member" ||
      action.kind === "block-member" ||
      action.kind === "remove-allowed-username"
    ) {
      const result =
        action.kind === "admit-member"
          ? runtime.identity.admit === undefined
            ? {
                kind: "unavailable" as const,
                cause: new Error("community administration is not configured"),
              }
            : await runtime.identity.admit(
                person,
                tokenToUuid(action.token),
                rpcCall(ctx, "manage_community"),
              )
          : action.kind === "block-member"
            ? runtime.identity.block === undefined
              ? {
                  kind: "unavailable" as const,
                  cause: new Error(
                    "community administration is not configured",
                  ),
                }
              : await runtime.identity.block(
                  person,
                  tokenToUuid(action.token),
                  rpcCall(ctx, "manage_community"),
                )
            : runtime.identity.removeAllowedUsername === undefined
              ? {
                  kind: "unavailable" as const,
                  cause: new Error(
                    "community administration is not configured",
                  ),
                }
              : await runtime.identity.removeAllowedUsername(
                  person,
                  action.username,
                  rpcCall(ctx, "manage_community"),
                );
      const confirmation =
        result.kind === "ok"
          ? result.value
            ? "Изменение сохранено."
            : "Состояние уже было актуальным."
          : result.kind === "invalid"
            ? "Identity отклонил изменение. Состав перечитан заново."
            : undefined;
      await renderCommunity(ctx, runtime, person, true, confirmation);
      outcome = adminOutcome(result, person.identityId);
      return;
    }
    if (action.kind === "hub" || action.kind === "outdated") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "list-visible-meetups",
        ...rpcCall(ctx, useCase),
      });
      await renderMeetupList(ctx, result);
      outcome = screenBoundary(result, {
        ok: ["meetup-list"],
        okMessage: "meetup list sent",
        rejectedMessage: "meetup list rejected",
        useCase,
      });
      return;
    }
    if (action.kind === "view-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderMeetupCard(
        ctx,
        result,
        true,
        runtime.presentation ?? "rich",
        person.globalRoles.includes("admin"),
      );
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup card sent",
        rejectedMessage: "meetup card rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "manage-edit" ||
      action.kind === "manage-field" ||
      action.kind === "manage-status" ||
      action.kind === "manage-unpublish" ||
      action.kind === "manage-cancel" ||
      action.kind === "manage-publish"
    ) {
      const meetupId = tokenToUuid(action.token);
      const current = await runtime.dispatcher.execute({
        identity: person,
        intent: "view-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      if (current.kind !== "meetup-card") {
        await renderMeetupCard(
          ctx,
          current,
          true,
          runtime.presentation ?? "rich",
          true,
        );
        outcome = screenBoundary(current, {
          ok: ["meetup-card"],
          okMessage: "meetup management opened",
          rejectedMessage: "meetup management rejected",
          useCase,
          meetupId,
        });
        return;
      }
      const meetup = current.meetup;
      const token = uuidToToken(meetup.id);
      if (meetup.lifecycle === "cancelled") {
        await editScreen(
          ctx,
          `Сходка «${meetup.title}» уже отменена. Изменять её больше нельзя.`,
          new InlineKeyboard().text("Открыть сходку", `v1:view:${token}`),
        );
        outcome = {
          level: "debug",
          message: "cancelled meetup management handled",
          result: "ok",
          use_case: "update_meetup",
          meetup_id: meetup.id,
        };
        return;
      }
      if (action.kind === "manage-edit") {
        await editScreen(
          ctx,
          `Что изменить в сходке «${meetup.title}»?`,
          new InlineKeyboard()
            .text("Название", `v1:manage:field:${token}:title`)
            .text("Дата и время", `v1:manage:field:${token}:schedule`)
            .row()
            .text("Место", `v1:manage:field:${token}:venue`)
            .text("Описание", `v1:manage:field:${token}:description`)
            .row()
            .text("Назад", `v1:view:${token}`),
        );
      } else if (action.kind === "manage-field") {
        await renderFormResult(
          ctx,
          {
            kind: "edit-ask",
            field: action.field,
            meetup,
          },
          questions,
          runtime.presentation ?? "rich",
        );
      } else if (action.kind === "manage-status") {
        await renderMeetupStatus(ctx, meetup);
      } else if (
        action.kind === "manage-cancel" &&
        meetup.lifecycle === "held"
      ) {
        await editScreen(
          ctx,
          "Состоявшуюся сходку отменить нельзя.",
          new InlineKeyboard().text("Назад", `v1:manage:status:${token}`),
        );
      } else if (action.kind === "manage-publish") {
        // Публикация — единственное действие статуса, которое не перечитывает
        // сходку в юзкейсе: устаревшую кнопку разбираем по снимку выше, иначе
        // домен ответит FailedPrecondition и человек увидит кадр недоступности
        // вместо причины отказа.
        const result = await runtime.dispatcher.execute({
          identity: person,
          intent: "publish-meetup",
          meetupId,
          ...rpcCall(ctx, useCase),
        });
        await renderStateResult(ctx, result, runtime.presentation ?? "rich");
        outcome = screenBoundary(result, {
          ok: ["published"],
          okMessage: "meetup published",
          rejectedMessage: "meetup republish rejected",
          useCase,
          meetupId,
        });
        return;
      } else {
        const verb =
          action.kind === "manage-unpublish"
            ? "скрыть сходку из общего списка"
            : "отменить сходку";
        const confirm =
          action.kind === "manage-unpublish"
            ? `v1:manage:confirm-unpublish:${token}`
            : `v1:manage:confirm-cancel:${token}`;
        await editScreen(
          ctx,
          `Точно ${verb} «${meetup.title}»?`,
          new InlineKeyboard()
            .text("Да, продолжить", confirm)
            .row()
            .text("Нет", `v1:manage:status:${token}`),
        );
      }
      outcome = {
        level: "debug",
        message: "meetup management step sent",
        result: "ok",
        use_case: "update_meetup",
        meetup_id: meetup.id,
      };
      return;
    }
    if (
      action.kind === "manage-confirm-unpublish" ||
      action.kind === "manage-confirm-cancel"
    ) {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "change-meetup-state",
        action:
          action.kind === "manage-confirm-unpublish" ? "unpublish" : "cancel",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderStateResult(ctx, result, runtime.presentation ?? "rich");
      outcome = screenBoundary(result, {
        ok: ["meetup-state-changed", "meetup-state-unchanged"],
        okMessage: "meetup state handled",
        rejectedMessage: "meetup state rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "manage-menu") {
      const id = createUuidV7();
      await ctx.reply("Управление сходками", {
        reply_markup: new InlineKeyboard()
          .text("Создать сходку", `v1:manage:new:${uuidToToken(id)}`)
          .row()
          .text("Состав сообщества", "v1:community:list"),
      });
      outcome = {
        level: "debug",
        message: "manage menu sent",
        result: "ok",
        use_case: useCase,
      };
      return;
    }
    if (action.kind === "create-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "create-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
      outcome = screenBoundary(result, {
        ok: ["ask", "preview", "published"],
        okMessage: "meetup form step sent",
        rejectedMessage: "meetup form step rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "publish-meetup") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "publish-meetup",
        meetupId,
        ...rpcCall(ctx, useCase),
      });
      await renderFormResult(
        ctx,
        result,
        questions,
        runtime.presentation ?? "rich",
      );
      outcome = screenBoundary(result, {
        ok: ["published"],
        okMessage: "meetup published",
        rejectedMessage: "meetup publish rejected",
        useCase,
        meetupId,
      });
      return;
    }
    const _exhaustive: never = action;
    outcome = unexpectedOutcome(
      `unhandled callback ${_exhaustive}`,
      undefined,
      useCase,
    );
  } catch (cause) {
    if (outcome === undefined) {
      outcome = unexpectedOutcome(cause, undefined, useCase);
    } else if (outcome.result === "error") {
      outcome = { ...outcome, reply_error: errorText(cause) };
    }
  } finally {
    if (outcome !== undefined) {
      writeBoundary(runtime.logger, ctx, outcome);
    }
  }
}

async function renderCommunity(
  ctx: UpdateContext,
  runtime: BotRuntime,
  actor: Person,
  edit: boolean,
  confirmation?: string,
): Promise<IdentityAdminResult<unknown>> {
  const result =
    runtime.identity.community === undefined
      ? {
          kind: "unavailable" as const,
          cause: new Error("community administration is not configured"),
        }
      : await runtime.identity.community(
          actor,
          rpcCall(ctx, "manage_community"),
        );
  if (result.kind !== "ok") {
    const text =
      result.kind === "forbidden"
        ? "Identity не разрешил управление составом."
        : unavailableText;
    if (edit)
      await editScreen(
        ctx,
        text,
        new InlineKeyboard().text("Назад", "v1:manage:menu"),
      );
    else await ctx.reply(text);
    return result;
  }
  const pending = result.value.members.filter((member) => !member.admitted);
  const admitted = result.value.members.filter((member) => member.admitted);
  const label = (member: (typeof result.value.members)[number]) =>
    member.telegramUsername === undefined
      ? member.identityId.slice(0, 8)
      : `@${member.telegramUsername}`;
  const lines = [
    ...(confirmation === undefined ? [] : [confirmation, ""]),
    "Состав сообщества",
    "",
    `Ожидают допуска: ${pending.length}`,
    ...(pending.length === 0
      ? ["—"]
      : pending.map((member) => `• ${label(member)}`)),
    "",
    `Допущены: ${admitted.length}`,
    ...(admitted.length === 0
      ? ["—"]
      : admitted.map((member) => `• ${label(member)}`)),
    "",
    "Разрешённые ники:",
    ...(result.value.allowedUsernames.length === 0
      ? ["—"]
      : result.value.allowedUsernames.map((username) => `• @${username}`)),
  ];
  const keyboard = new InlineKeyboard();
  for (const member of pending)
    keyboard
      .text(
        `Допустить ${label(member)}`,
        `v1:community:admit:${uuidToToken(member.identityId)}`,
      )
      .row();
  for (const member of admitted)
    keyboard
      .text(
        `Закрыть ${label(member)}`,
        `v1:community:block:${uuidToToken(member.identityId)}`,
      )
      .row();
  keyboard.text("Добавить ник", "v1:community:allow").row();
  // Кнопка рисуется только для ника, который доедет обратно в `callback_data`:
  // более длинный вышиб бы весь экран отказом Telegram на 64 байта, а разбор
  // всё равно назвал бы его сломанным.
  for (const username of result.value.allowedUsernames) {
    if (!removableUsernamePattern.test(username)) continue;
    keyboard
      .text(`Убрать @${username}`, `v1:community:remove:${username}`)
      .row();
  }
  keyboard
    .text("Обновить", "v1:community:list")
    .text("Назад", "v1:manage:menu");
  if (edit) await editScreen(ctx, lines.join("\n"), keyboard);
  else await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
  return result;
}

function adminOutcome(
  result: IdentityAdminResult<unknown>,
  identityId: string,
): BoundaryOutcome {
  if (result.kind === "ok")
    return {
      level: "debug",
      message: "community changed",
      result: "ok",
      use_case: "manage_community",
      identity_id: identityId,
    };
  return {
    level: "warn",
    message: "community change rejected",
    result: "error",
    use_case: "manage_community",
    identity_id: identityId,
    error_category:
      result.kind === "forbidden"
        ? "authorization"
        : result.kind === "invalid"
          ? "invariant"
          : "dependency_unavailable",
    error: result.kind,
  };
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
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
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
  const dated = meetups.filter((meetup) => meetup.schedule !== undefined);
  const undated = meetups.filter((meetup) => meetup.schedule === undefined);
  const sections = [
    meetupSection("С датой", dated),
    meetupSection("Без даты", undated),
  ].filter((section) => section !== undefined);
  return ["Ближайшие сходки", ...sections].join("\n\n");
}

function meetupSection(
  heading: string,
  meetups: readonly MeetupSummary[],
): string | undefined {
  return meetups.length === 0
    ? undefined
    : `${heading}\n${meetups.map(meetupListLine).join("\n")}`;
}

function meetupListKeyboard(meetups: readonly MeetupSummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const meetup of meetups) {
    keyboard.text(meetup.title, `v1:view:${uuidToToken(meetup.id)}`).row();
  }
  return keyboard.text("Обновить", "v1:nav:hub");
}

async function renderMeetupCard(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  edit: boolean,
  presentation: "rich" | "plain",
  manageable = false,
): Promise<void> {
  if (result.kind === "meetup-not-found") {
    const text = "Сходка не найдена или больше недоступна.";
    const keyboard = new InlineKeyboard().text("К списку", "v1:nav:hub");
    if (edit) await editScreen(ctx, text, keyboard);
    else await ctx.reply(text, { reply_markup: keyboard });
    return;
  }
  if (result.kind === "meetup-card") {
    const text = meetupCardText(result.meetup);
    const token = uuidToToken(result.meetup.id);
    const keyboard = new InlineKeyboard();
    if (manageable && result.meetup.lifecycle !== "cancelled") {
      keyboard
        .text("Изменить", `v1:manage:edit:${token}`)
        .text("Статус", `v1:manage:status:${token}`)
        .row();
    }
    keyboard
      .text("Обновить", `v1:view:${token}`)
      .row()
      .text("К списку", "v1:nav:hub");
    if (presentation === "rich") {
      const richMessage = { html: meetupCardHtml(result.meetup) };
      if (
        edit &&
        ctx.chat !== undefined &&
        ctx.callbackQuery?.message !== undefined
      ) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            richMessage,
            { reply_markup: keyboard },
          );
        } catch (cause) {
          if (!errorText(cause).includes("message is not modified")) {
            await ctx.replyWithRichMessage(richMessage, {
              reply_markup: keyboard,
            });
          }
        }
      } else {
        await ctx.replyWithRichMessage(richMessage, { reply_markup: keyboard });
      }
    } else if (edit) await editScreen(ctx, text, keyboard);
    else await ctx.reply(text, { reply_markup: keyboard });
    return;
  }
  const keyboard = new InlineKeyboard().text("Повторить", "v1:nav:hub");
  if (edit) await editScreen(ctx, unavailableText, keyboard);
  else await ctx.reply(unavailableText, { reply_markup: keyboard });
}

async function renderMeetupStatus(
  ctx: UpdateContext,
  meetup: MeetupSnapshot,
): Promise<void> {
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  if (meetup.visibility === "visible") {
    keyboard.text("Скрыть из списка", `v1:manage:unpublish:${token}`).row();
  } else {
    keyboard.text("Опубликовать", `v1:manage:republish:${token}`).row();
  }
  if (meetup.lifecycle === "planned") {
    keyboard.text("Отменить сходку", `v1:manage:cancel:${token}`).row();
  }
  keyboard.text("Назад", `v1:view:${token}`);
  await editScreen(
    ctx,
    `Управление статусом\n\n${meetupCardText(meetup)}`,
    keyboard,
  );
}

async function renderStateResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  presentation: "rich" | "plain",
): Promise<void> {
  if (result.kind === "published" || result.kind === "meetup-state-changed") {
    await renderMeetupCard(
      ctx,
      { kind: "meetup-card", meetup: result.meetup },
      true,
      presentation,
      true,
    );
    return;
  }
  if (result.kind === "meetup-state-unchanged") {
    const token = uuidToToken(result.meetup.id);
    const text =
      result.reason === "already-cancelled"
        ? "Сходка уже отменена. Повторно ничего не изменилось."
        : "Сходка уже скрыта из общего списка.";
    await editScreen(
      ctx,
      text,
      new InlineKeyboard().text("Открыть сходку", `v1:view:${token}`),
    );
    return;
  }
  if (result.kind === "meetup-not-found") {
    await renderMeetupCard(ctx, result, true, presentation, true);
    return;
  }
  if (result.kind === "conflict") {
    const token = uuidToToken(result.meetup.id);
    const label =
      result.action === "cancel" ? "Отменить сходку" : "Скрыть из списка";
    const callback =
      result.action === "cancel"
        ? `v1:manage:confirm-cancel:${token}`
        : `v1:manage:confirm-unpublish:${token}`;
    await editScreen(
      ctx,
      `${conflictText}\n\nПроверь данные и подтверди действие ещё раз.`,
      new InlineKeyboard().text(label, callback),
    );
    return;
  }
  const text =
    result.kind === "dependency-rejected" && result.reason === "invalid"
      ? `Не получилось выполнить действие: ${result.message}`
      : result.kind === "dependency-rejected" && result.reason === "forbidden"
        ? "Meetups не разрешил это действие."
        : unavailableText;
  await editScreen(
    ctx,
    text,
    new InlineKeyboard().text("К списку", "v1:nav:hub"),
  );
}

function meetupCardHtml(meetup: MeetupSnapshot): string {
  const lines = meetupCardText(meetup).split("\n");
  const title = escapeHtml(lines.shift() ?? "");
  return `<h1>${title}</h1><p>${lines.map(escapeHtml).join("<br>")}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function meetupCardText(meetup: MeetupSnapshot): string {
  const lifecycle =
    meetup.lifecycle === "cancelled"
      ? "отменена"
      : meetup.lifecycle === "held"
        ? "состоялась"
        : "запланирована";
  const visibility = meetup.visibility === "hidden" ? "скрыта" : "видна";
  const when = formatSchedule(meetup);
  const venue = meetup.venue === "" ? "не указано" : meetup.venue;
  const description =
    meetup.description === ""
      ? "Описание пока не добавлено."
      : meetup.description;
  return `${meetup.title}\nСтатус: ${lifecycle}, ${visibility}\n\nКогда: ${when}\nГде: ${venue}\n\n${description}`;
}

function meetupListLine(meetup: MeetupSummary): string {
  if (meetup.schedule === undefined) {
    return `• ${meetup.title}`;
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
  return `• ${day} ${monthLabel}, ${weekdayLabel} — ${meetup.title}`;
}

async function denyHubAccessIfNeeded(
  ctx: UpdateContext,
  identity: { person: Person; blocked: boolean },
  useCase: ProductUseCase | undefined,
  edit: boolean,
): Promise<BoundaryOutcome | undefined> {
  const access = decideHubAccess(identity.person.globalRoles, identity.blocked);
  if (access === "admitted") {
    return undefined;
  }
  const text = hubAccessTexts[access];
  if (edit) {
    await editScreen(ctx, text, new InlineKeyboard());
  } else {
    await ctx.reply(text);
  }
  return hubAccessOutcome(access, identity.person.identityId, useCase);
}

function hubAccessOutcome(
  access: Exclude<HubAccess, "admitted">,
  identityId: string,
  useCase: ProductUseCase | undefined,
): BoundaryOutcome {
  return {
    level: "warn",
    message: "hub access denied",
    result: "error",
    ...(useCase === undefined ? {} : { use_case: useCase }),
    identity_id: identityId,
    error_category: "authorization",
    error: hubAccessErrors[access],
  };
}

async function resolvePerson(
  ctx: UpdateContext,
  runtime: BotRuntime,
  useCase?: ProductUseCase,
  retryCallback?: string,
): Promise<
  | { kind: "resolved"; person: Person; blocked: boolean }
  | { kind: "failed"; outcome: BoundaryOutcome }
> {
  const from = ctx.from;
  if (from === undefined) {
    return {
      kind: "failed",
      outcome: unexpectedOutcome("sender is missing", undefined, useCase),
    };
  }
  const resolved = await runtime.identity.resolve(
    toResolveIdentityInput(BigInt(from.id), from.username),
    rpcCall(ctx, useCase),
  );
  if (resolved.kind !== "resolved") {
    if (retryCallback === undefined) {
      await ctx.reply(unavailableText);
    } else {
      await editScreen(
        ctx,
        unavailableText,
        new InlineKeyboard().text("Повторить", retryCallback),
      );
    }
    return {
      kind: "failed",
      outcome: identityFailureOutcome(resolved, useCase),
    };
  }
  return {
    kind: "resolved",
    person: {
      identityId: resolved.identityId,
      globalRoles: resolved.globalRoles,
    },
    blocked: resolved.blocked,
  };
}

async function renderFormResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  questions: Map<string, PendingInput>,
  presentation: "rich" | "plain",
): Promise<void> {
  if (result.kind === "ask" || result.kind === "edit-ask") {
    const currentValue =
      result.field === "schedule"
        ? formatSchedule(result.meetup)
        : result.meetup[result.field] === ""
          ? "не задано"
          : result.meetup[result.field];
    const prompt =
      result.kind === "edit-ask"
        ? `Сейчас: ${currentValue}\n${result.error ?? formPrompts[result.field]}`
        : (result.error ?? formPrompts[result.field]);
    const text =
      result.kind === "edit-ask"
        ? editQuestionText(prompt, uuidToToken(result.meetup.id), result.field)
        : prompt;
    const message = await ctx.reply(text, {
      reply_markup: { force_reply: true, selective: true },
    });
    questions.set(questionKey(ctx.chat?.id, message.message_id), {
      kind: "meetup",
      mode: result.kind === "edit-ask" ? "edit" : "create",
      field: result.field,
      meetupId: result.meetup.id,
      telegramUserId: ctx.from?.id ?? 0,
      expiresAt: Date.now() + questionTtlMs,
    });
    evictOldestQuestions(questions);
    return;
  }
  if (result.kind === "conflict") {
    const stored = result.meetup;
    const lines = [
      conflictText,
      "",
      `Сейчас: ${stored.title}`,
      formatSchedule(stored),
      stored.venue,
      stored.description,
      ...(result.input === undefined
        ? []
        : ["", `Ваше значение: ${result.input}`]),
    ];
    // Публикация подтверждается повторно по обновлённым данным: кнопка снова
    // несёт снимок, который человек только что видел.
    if (result.field === undefined) {
      await ctx.reply(
        `${lines.join("\n")}\n\nПроверь данные и подтверди публикацию ещё раз.`,
        {
          reply_markup: new InlineKeyboard().text(
            "Опубликовать",
            `v1:manage:publish:${uuidToToken(stored.id)}`,
          ),
        },
      );
      return;
    }
    // Правка поля: сохранённый ввод показан, но повторно не отправляется — его
    // вводят заново, уже по актуальным данным. Режим вопроса сохраняет ту же
    // форму (создание или редактирование), в которой конфликт случился.
    const text =
      result.editing === true
        ? editQuestionText(
            `Сейчас: ${lines.join("\n")}\n\n${formPrompts[result.field]}`,
            uuidToToken(stored.id),
            result.field,
          )
        : `${lines.join("\n")}\n\n${formPrompts[result.field]}`;
    const message = await ctx.reply(text, {
      reply_markup: { force_reply: true, selective: true },
    });
    questions.set(questionKey(ctx.chat?.id, message.message_id), {
      kind: "meetup",
      mode: result.editing === true ? "edit" : "create",
      field: result.field,
      meetupId: stored.id,
      telegramUserId: ctx.from?.id ?? 0,
      expiresAt: Date.now() + questionTtlMs,
    });
    evictOldestQuestions(questions);
    return;
  }
  if (result.kind === "meetup-updated") {
    await ctx.reply("Изменение сохранено.");
    await renderMeetupCard(
      ctx,
      { kind: "meetup-card", meetup: result.meetup },
      false,
      presentation,
      true,
    );
    return;
  }
  if (result.kind === "edit-unavailable") {
    await ctx.reply("Сходка уже отменена. Изменять её больше нельзя.", {
      reply_markup: new InlineKeyboard().text(
        "Открыть сходку",
        `v1:view:${uuidToToken(result.meetup.id)}`,
      ),
    });
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
    const meetupId = result.meetup.id;
    await ctx.reply(
      `Сходка создана. Теперь она видна в списке.\n\nСсылка для чата:\n${meetupStartLink(ctx.me.username, meetupId)}`,
      {
        reply_markup: new InlineKeyboard()
          .text("Открыть сходку", `v1:view:${uuidToToken(meetupId)}`)
          .text("К управлению", "v1:manage:menu"),
      },
    );
    return;
  }
  if (result.kind === "dependency-rejected") {
    if (result.reason === "invalid") {
      await ctx.reply(`Не получилось сохранить значение: ${result.message}`);
      return;
    }
    if (result.reason === "conflict") {
      await ctx.reply(conflictText);
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
  questions: Map<string, PendingInput>,
  now: number,
): void {
  for (const [key, question] of questions) {
    if (question.expiresAt <= now) questions.delete(key);
  }
}

function evictOldestQuestions(questions: Map<string, PendingInput>): void {
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

function rpcCall(ctx: UpdateContext, useCase?: ProductUseCase): RpcMetadata {
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(useCase === undefined ? {} : { useCase }),
  };
}

function callbackUseCase(
  kind:
    | "hub"
    | "outdated"
    | "view-meetup"
    | "manage-menu"
    | "community"
    | "ask-allowed-username"
    | "admit-member"
    | "block-member"
    | "remove-allowed-username"
    | "create-meetup"
    | "publish-meetup"
    | "manage-edit"
    | "manage-field"
    | "manage-status"
    | "manage-publish"
    | "manage-unpublish"
    | "manage-confirm-unpublish"
    | "manage-cancel"
    | "manage-confirm-cancel",
): ProductUseCase {
  switch (kind) {
    case "view-meetup":
      return "view_meetup";
    case "create-meetup":
    case "publish-meetup":
    case "manage-menu":
      return "create_meetup";
    case "manage-edit":
    case "manage-field":
    case "manage-status":
    case "manage-publish":
    case "manage-unpublish":
    case "manage-confirm-unpublish":
    case "manage-cancel":
    case "manage-confirm-cancel":
      return "update_meetup";
    case "community":
    case "ask-allowed-username":
    case "admit-member":
    case "block-member":
    case "remove-allowed-username":
      return "manage_community";
    case "hub":
    case "outdated":
      return "find_meetup";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function questionKey(chatId: number | undefined, messageId: number): string {
  return `${chatId ?? "unknown"}:${messageId}`;
}
// Экран границы кончается либо отрисовкой, либо отказом. Разбор отказа везде
// один и тот же, поэтому вызывающий называет только те kind, которые считает
// успехом своего экрана; всё остальное — отказ зависимости или дефект.
type BoundaryScreen = {
  ok: readonly ExecuteResult["kind"][];
  okMessage: string;
  rejectedMessage: string;
  useCase: ProductUseCase;
  meetupId?: string;
};

function screenBoundary(
  result: ExecuteResult,
  screen: BoundaryScreen,
): BoundaryOutcome {
  const meetup =
    screen.meetupId === undefined ? {} : { meetup_id: screen.meetupId };
  if (result.kind === "meetup-not-found") {
    return {
      level: "warn",
      message: "meetup not visible",
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "visibility",
      error: "meetup_not_visible",
    };
  }
  if (screen.ok.includes(result.kind)) {
    return {
      level: "debug",
      message: screen.okMessage,
      result: "ok",
      use_case: screen.useCase,
      ...meetup,
    };
  }
  // Конфликт версий — не сбой зависимости и не неожиданность: запрос собран
  // верно, но показанный снимок устарел. Человеку уходит текущая карточка, а в
  // записи границы отказ отличим от отказа по праву собственным error.
  if (result.kind === "conflict") {
    return {
      level: "warn",
      message: screen.rejectedMessage,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: "invariant",
      error: "version_conflict",
    };
  }
  if (result.kind === "dependency-rejected") {
    return {
      level: "warn",
      message: screen.rejectedMessage,
      result: "error",
      use_case: screen.useCase,
      ...meetup,
      error_category: dependencyCategory(result.reason),
      error: result.reason,
    };
  }
  return {
    level: "error",
    message: screen.rejectedMessage,
    result: "error",
    use_case: screen.useCase,
    ...meetup,
    error_category: "unexpected",
    error: result.kind === "rejected" ? result.reason : result.kind,
  };
}

// Недоступность зависимости и отвергнутый ею вызов — разные отказы: первый
// проходит по повтору, второй никогда. Человеку в обоих случаях уходит один и
// тот же fail-closed ответ, различие живёт в записи границы.
function identityFailureOutcome(
  resolved:
    | { kind: "unavailable"; cause: unknown }
    | { kind: "rejected"; code: string; cause: unknown },
  useCase?: ProductUseCase,
): BoundaryOutcome {
  if (resolved.kind === "rejected") {
    return {
      level: "error",
      message: "identity rejected the request",
      result: "error",
      ...(useCase === undefined ? {} : { use_case: useCase }),
      error_category: grpcFailureCategory(resolved.code),
      grpc_code: resolved.code,
      error: errorText(resolved.cause),
    };
  }
  return {
    level: "error",
    message: "identity unavailable",
    result: "error",
    ...(useCase === undefined ? {} : { use_case: useCase }),
    error_category: unavailableCategory(resolved.cause),
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
  useCase?: ProductUseCase,
): BoundaryOutcome {
  const outcome: BoundaryOutcome = {
    level: "error",
    message: "update handler failed",
    result: "error",
    error_category: "unexpected",
    error: errorText(cause),
  };
  if (useCase !== undefined) {
    outcome.use_case = useCase;
  }
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
    operation: boundaryOperation(ctx),
    result: outcome.result,
  };
  if (ctx.requestId !== undefined && ctx.requestId !== "") {
    fields.request_id = ctx.requestId;
  }
  if (outcome.identity_id !== undefined) {
    fields.identity_id = outcome.identity_id;
  }
  if (ctx.startedAt !== undefined) {
    fields.duration_us = elapsedUs(ctx.startedAt);
  }
  if (outcome.use_case !== undefined) {
    fields.use_case = outcome.use_case;
  }
  if (outcome.meetup_id !== undefined) {
    fields.meetup_id = outcome.meetup_id;
  }
  if (outcome.result === "error") {
    countFailure(outcome.error_category);
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

function boundaryOperation(ctx: UpdateContext): "message" | "callback_query" {
  return ctx.update.callback_query === undefined ? "message" : "callback_query";
}

function grpcFailureCategory(code: string): FailureCategory {
  switch (code) {
    case "PermissionDenied":
    case "Unauthenticated":
      return "authorization";
    case "DeadlineExceeded":
      return "timeout";
    case "Unavailable":
      return "dependency_unavailable";
    case "InvalidArgument":
    case "FailedPrecondition":
    case "Aborted":
    case "AlreadyExists":
    case "NotFound":
    case "OutOfRange":
      return "invariant";
    default:
      return "unexpected";
  }
}

function dependencyCategory(reason: string): FailureCategory {
  switch (reason) {
    case "forbidden":
      return "authorization";
    case "invalid":
    case "conflict":
      return "invariant";
    case "timeout":
      return "timeout";
    default:
      return "dependency_unavailable";
  }
}

function unavailableCategory(cause: unknown): FailureCategory {
  const text = errorText(cause).toLowerCase();
  return text.includes("deadline") || text.includes("timeout")
    ? "timeout"
    : "dependency_unavailable";
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
