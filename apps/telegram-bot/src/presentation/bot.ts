import { randomUUID } from "node:crypto";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { Dispatcher } from "../application/dispatcher.js";
import {
  decideHubAccess,
  type HubAccess,
  hubAccessErrors,
  hubAccessTexts,
} from "../application/hub-access.js";
import {
  formatLocalMoment,
  formatSchedule,
} from "../application/meetup-form.js";
import type {
  ExecuteResult,
  FormField,
  MeetupStateAction,
  Person,
  PublishMomentRetry,
} from "../application/types.js";
import { startExecuteRequest } from "../application/types.js";
import { countFailure, type FailureCategory } from "../failures.js";
import {
  type CommunityAdministrator,
  type IdentityAdminResult,
  type IdentityResolver,
  toResolveIdentityInput,
} from "../identity/port.js";
import type { LogFields, Logger } from "../logging.js";
import type {
  ArchivedMeetupSummary,
  MeetupMaterial,
  MeetupSnapshot,
  MeetupSummary,
} from "../meetups/port.js";
import type { NotificationCategory } from "../notifications/port.js";
import type { RpcMetadata } from "../rpc-metadata.js";
import {
  editQuestionText,
  parseEditQuestion,
  parsePublishMomentQuestion,
  publishMomentQuestionText,
} from "./edit-question.js";
import {
  type PendingMaterialSource as MaterialInputSource,
  materialConfirmationText,
  parseMaterialConfirmation,
  parseMaterialInput,
} from "./material-input.js";
import {
  meetupStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import {
  type CallbackAction,
  parseCallback,
  removableUsernamePattern,
} from "./parse-callback.js";
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
const materialForbiddenText = "Это действие доступно организатору сходки.";
type ProductUseCase =
  | "create_meetup"
  | "update_meetup"
  | "find_meetup"
  | "view_meetup"
  | "manage_community"
  | "manage_notifications";
const questionTtlMs = 60 * 60 * 1_000;
const questionLimit = 1_000;
const materialPageSize = 8;
const materialCardLimit = 20;

// Общая форма для трёх действий смены состояния: кадр подтверждения и повтор
// после конфликта версий говорят об одном и том же действии одними словами.
const stateActionCopy: Record<
  MeetupStateAction,
  { verb: string; label: string; confirmAction: string }
> = {
  unpublish: {
    verb: "скрыть сходку из общего списка",
    label: "Скрыть из списка",
    confirmAction: "confirm-unpublish",
  },
  cancel: {
    verb: "отменить сходку",
    label: "Отменить сходку",
    confirmAction: "confirm-cancel",
  },
  hold: {
    verb: "отметить сходку состоявшейся",
    label: "Отметить состоявшейся",
    confirmAction: "confirm-hold",
  },
  unschedule: {
    verb: "отменить отложенную публикацию сходки",
    label: "Отменить отложенную публикацию",
    confirmAction: "confirm-unschedule",
  },
};

const publishMomentPrompt =
  "Когда опубликовать сходку? Напиши дату и время по времени сообщества: ДД.ММ.ГГГГ ЧЧ:ММ";
// Прошедший момент — отдельный отказ со своим текстом, а не «не разобрал
// дату»: ввод понят, но время уже наступило (E-02, открытый вопрос раскадровки).
const publishMomentRetryText: Record<PublishMomentRetry, string> = {
  unparsed: "Не получилось разобрать дату. Напиши, например: 21.09.2026 19:30",
  past: "Это время уже прошло или его нельзя назначить по времени сообщества. Назначь публикацию на момент в будущем: ДД.ММ.ГГГГ ЧЧ:ММ",
  conflict: `${conflictText}\n\n${publishMomentPrompt}`,
};

// Одна таблица «кнопка → действие» для шага вопроса и шага подтверждения:
// новое действие смены состояния добавляется строкой, а не двумя цепочками.
const stateActionByCallback: Record<
  Extract<
    CallbackAction["kind"],
    `manage-${"" | "confirm-"}${"unpublish" | "cancel" | "hold" | "unschedule"}`
  >,
  MeetupStateAction
> = {
  "manage-unpublish": "unpublish",
  "manage-confirm-unpublish": "unpublish",
  "manage-cancel": "cancel",
  "manage-confirm-cancel": "cancel",
  "manage-hold": "hold",
  "manage-confirm-hold": "hold",
  "manage-unschedule": "unschedule",
  "manage-confirm-unschedule": "unschedule",
};

function confirmStateCallback(
  action: MeetupStateAction,
  token: string,
): string {
  return `v1:manage:${stateActionCopy[action].confirmAction}:${token}`;
}
const materialDisplayTitleLimit = 80;

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
type PendingMaterialInput = {
  kind: "material-source";
  meetupId: string;
  telegramUserId: number;
  expiresAt: number;
};
type PendingMaterialTitle = {
  kind: "material-title";
  meetupId: string;
  source: MaterialInputSource;
  telegramUserId: number;
  expiresAt: number;
};
type PendingPublishMoment = {
  kind: "publish-moment";
  meetupId: string;
  telegramUserId: number;
  expiresAt: number;
};
type PendingInput =
  | PendingQuestion
  | PendingPublishMoment
  | PendingUsername
  | PendingMaterialInput
  | PendingMaterialTitle;

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
    const recoveredMoment =
      storedPending === undefined && repliedMessage?.from?.id === ctx.me.id
        ? parsePublishMomentQuestion(repliedText)
        : undefined;
    const pending: PendingInput | undefined =
      storedPending ??
      (recoveredEdit !== undefined
        ? {
            kind: "meetup" as const,
            mode: "edit" as const,
            field: recoveredEdit.field,
            meetupId: tokenToUuid(recoveredEdit.token),
            telegramUserId: ctx.from?.id ?? 0,
            expiresAt: Date.now() + questionTtlMs,
          }
        : recoveredMoment !== undefined
          ? {
              kind: "publish-moment" as const,
              meetupId: tokenToUuid(recoveredMoment.token),
              telegramUserId: ctx.from?.id ?? 0,
              expiresAt: Date.now() + questionTtlMs,
            }
          : undefined);
    if (
      replyId !== undefined &&
      pending?.kind === "publish-moment" &&
      ctx.message?.text !== undefined
    ) {
      useCase = "update_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "debug",
          message: "foreign publish moment answer ignored",
          result: "ok",
          use_case: useCase,
        };
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
        intent: "schedule-publication",
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
          "ask-publish-moment",
          "publication-scheduled",
          "publication-unavailable",
        ],
        okMessage: "publish moment answer handled",
        rejectedMessage: "publish moment answer rejected",
        useCase,
        meetupId: pending.meetupId,
      });
      return;
    }
    if (
      replyId !== undefined &&
      (pending?.kind === "material-source" ||
        pending?.kind === "material-title")
    ) {
      useCase = "update_meetup";
      if (ctx.from?.id !== pending.telegramUserId) {
        outcome = {
          level: "debug",
          message: "foreign material answer ignored",
          result: "ok",
          use_case: useCase,
        };
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
      if (!identity.person.globalRoles.includes("admin")) {
        questions.delete(questionKey(ctx.chat?.id, replyId));
        await ctx.reply(materialForbiddenText);
        outcome = materialForbiddenOutcome(identity.person, pending.meetupId);
        return;
      }
      if (pending.kind === "material-source") {
        const source = parseMaterialInput(ctx.message);
        if (source === undefined) {
          await ctx.reply(
            "На это сообщение нельзя дать ссылку: источник скрыт или пересылка из него запрещена. Пришли пересланное сообщение с доступным источником, фотографию или документ.",
          );
          outcome = {
            level: "debug",
            message: "material source rejected",
            result: "ok",
            use_case: useCase,
            meetup_id: pending.meetupId,
            identity_id: identity.person.identityId,
          };
          return;
        }
        questions.delete(questionKey(ctx.chat?.id, replyId));
        const prompt = await ctx.reply(
          "Как назвать материал в карточке? Напиши короткое название.",
          { reply_markup: { force_reply: true, selective: true } },
        );
        questions.set(questionKey(ctx.chat?.id, prompt.message_id), {
          kind: "material-title",
          meetupId: pending.meetupId,
          source,
          telegramUserId: pending.telegramUserId,
          expiresAt: Date.now() + questionTtlMs,
        });
        evictOldestQuestions(questions);
        outcome = {
          level: "debug",
          message: "material title requested",
          result: "ok",
          use_case: useCase,
          meetup_id: pending.meetupId,
          identity_id: identity.person.identityId,
        };
        return;
      }
      const title = ctx.message?.text?.trim();
      if (title === undefined || title === "" || title.length > 200) {
        questions.delete(questionKey(ctx.chat?.id, replyId));
        const prompt = await ctx.reply(
          "Название должно быть текстом от 1 до 200 символов. Напиши короткое название.",
          { reply_markup: { force_reply: true, selective: true } },
        );
        questions.set(questionKey(ctx.chat?.id, prompt.message_id), {
          ...pending,
          expiresAt: Date.now() + questionTtlMs,
        });
        evictOldestQuestions(questions);
        outcome = {
          level: "debug",
          message: "material title rejected",
          result: "ok",
          use_case: useCase,
          meetup_id: pending.meetupId,
          identity_id: identity.person.identityId,
        };
        return;
      }
      questions.delete(questionKey(ctx.chat?.id, replyId));
      await sendMaterialConfirmation(
        ctx,
        pending.meetupId,
        title,
        pending.source,
      );
      outcome = {
        level: "debug",
        message: "material confirmation sent",
        result: "ok",
        use_case: useCase,
        meetup_id: pending.meetupId,
        identity_id: identity.person.identityId,
      };
      return;
    }
    if (
      replyId !== undefined &&
      pending !== undefined &&
      (pending.kind === "allowed-username" || pending.kind === "meetup") &&
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
        await ctx.reply(result.text, { reply_markup: homeKeyboard() });
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
      case "ask-publish-moment":
      case "publication-scheduled":
      case "publication-unavailable":
      case "meetup-updated":
      case "meetup-state-changed":
      case "meetup-state-unchanged":
      case "edit-unavailable":
      case "conflict":
      case "material-attached":
      case "material-removed":
      case "meetup-list":
      case "meetup-notification-settings":
      case "global-notification-settings":
      case "archived-meetup-list":
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
    if (action.kind === "open-material-file") {
      const meetupId = tokenToUuid(action.token);
      const materialId = tokenToUuid(action.materialToken);
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
        );
        outcome = screenBoundary(current, {
          ok: ["meetup-card"],
          okMessage: "material file sent",
          rejectedMessage: "material file rejected",
          useCase,
          meetupId,
        });
        return;
      }
      const material = current.meetup.materials.find(
        (candidate) =>
          candidate.id === materialId && candidate.source.kind === "file",
      );
      if (material === undefined || material.source.kind !== "file") {
        await editScreen(
          ctx,
          "Материал больше не найден. Открой актуальную карточку сходки.",
          new InlineKeyboard().text(
            "Открыть сходку",
            `v1:view:${action.token}`,
          ),
        );
        outcome = {
          level: "warn",
          message: "material file missing",
          result: "error",
          use_case: useCase,
          meetup_id: meetupId,
          identity_id: person.identityId,
          error_category: "visibility",
          error: "material_not_visible",
        };
        return;
      }
      const delivery = await sendStoredMaterialFile(
        ctx,
        material.source.fileId,
        material.title,
      );
      if (delivery.kind === "failed") {
        await ctx.reply(
          "Не получилось показать материал. Возможно, файл больше недоступен или Telegram временно не отвечает.",
        );
        outcome = unexpectedOutcome(
          delivery.cause,
          undefined,
          useCase,
          meetupId,
          person.identityId,
        );
        return;
      }
      outcome = {
        level: "debug",
        message: "material file sent",
        result: "ok",
        use_case: useCase,
        meetup_id: meetupId,
        identity_id: person.identityId,
      };
      return;
    }
    if (action.kind === "confirm-attach-material") {
      const meetupId = tokenToUuid(action.token);
      const confirmation = parseMaterialConfirmation(
        ctx.callbackQuery?.message,
      );
      if (confirmation === undefined) {
        await editScreen(
          ctx,
          "Этот экран прикрепления устарел. Начни действие заново из карточки сходки.",
          new InlineKeyboard().text(
            "Открыть сходку",
            `v1:view:${action.token}`,
          ),
        );
        outcome = {
          level: "warn",
          message: "material confirmation malformed",
          result: "error",
          use_case: useCase,
          meetup_id: meetupId,
          identity_id: person.identityId,
          error_category: "invariant",
          error: "material confirmation failed validation",
        };
        return;
      }
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "attach-material",
        meetupId,
        material: {
          id: tokenToUuid(action.materialToken),
          title: confirmation.title,
          source: confirmation.source,
        },
        ...rpcCall(ctx, useCase),
      });
      await renderMaterialResult(ctx, result);
      outcome = screenBoundary(result, {
        ok: ["material-attached"],
        okMessage: "material attached",
        rejectedMessage: "material attach rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (action.kind === "confirm-remove-material") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "remove-material",
        meetupId,
        materialId: tokenToUuid(action.materialToken),
        ...rpcCall(ctx, useCase),
      });
      await renderMaterialResult(ctx, result);
      outcome = screenBoundary(result, {
        ok: ["material-removed"],
        okMessage: "material removed",
        rejectedMessage: "material removal rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "manage-materials" ||
      action.kind === "begin-attach-material" ||
      action.kind === "remove-material"
    ) {
      const meetupId = tokenToUuid(action.token);
      const canManageMaterials = person.globalRoles.includes("admin");
      if (action.kind !== "manage-materials" && !canManageMaterials) {
        await editScreen(
          ctx,
          materialForbiddenText,
          new InlineKeyboard().text(
            "Открыть сходку",
            `v1:view:${action.token}`,
          ),
        );
        outcome = materialForbiddenOutcome(person, meetupId);
        return;
      }
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
          okMessage: "material management opened",
          rejectedMessage: "material management rejected",
          useCase,
          meetupId,
        });
        return;
      }
      if (
        current.meetup.lifecycle === "cancelled" &&
        action.kind !== "manage-materials"
      ) {
        await editScreen(
          ctx,
          "Сходка уже отменена. Изменять её материалы больше нельзя.",
          new InlineKeyboard().text(
            "Открыть сходку",
            `v1:view:${action.token}`,
          ),
        );
      } else if (action.kind === "manage-materials") {
        await renderMaterialManagement(
          ctx,
          current.meetup,
          canManageMaterials,
          action.page ?? 0,
        );
      } else if (action.kind === "begin-attach-material") {
        const prompt = await ctx.reply(
          `Перешли сообщение или отправь фотографию либо документ для сходки «${current.meetup.title}». Я не читаю чат целиком: связь появится только после твоего подтверждения.`,
          { reply_markup: { force_reply: true, selective: true } },
        );
        questions.set(questionKey(ctx.chat?.id, prompt.message_id), {
          kind: "material-source",
          meetupId,
          telegramUserId: ctx.from?.id ?? 0,
          expiresAt: Date.now() + questionTtlMs,
        });
        evictOldestQuestions(questions);
      } else {
        const materialId = tokenToUuid(action.materialToken);
        const material = current.meetup.materials.find(
          (candidate) => candidate.id === materialId,
        );
        await editScreen(
          ctx,
          material === undefined
            ? "Материал уже отсутствует. Оригинал в Telegram не изменён."
            : `Убрать материал «${materialTitle(material, 1)}» из сходки? Оригинал в Telegram останется на месте.`,
          material === undefined
            ? new InlineKeyboard().text(
                "К материалам",
                `v1:mm:list:${action.token}`,
              )
            : new InlineKeyboard()
                .text(
                  "Да, убрать",
                  `v1:mm:confirm-rm:${action.token}:${action.materialToken}`,
                )
                .row()
                .text("Нет", `v1:mm:list:${action.token}`),
        );
      }
      outcome = {
        level: "debug",
        message: "material management step sent",
        result: "ok",
        use_case: useCase,
        meetup_id: meetupId,
        identity_id: person.identityId,
      };
      return;
    }
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
    if (action.kind === "home") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "start",
      });
      if (result.kind === "message") {
        await editScreen(ctx, result.text, homeKeyboard());
        outcome = {
          level: "debug",
          message: "start screen sent",
          result: "ok",
          use_case: useCase,
        };
      } else {
        outcome = unexpectedOutcome(
          `unexpected start result ${result.kind}`,
          undefined,
          useCase,
        );
      }
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
    if (action.kind === "archive") {
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "list-archived-meetups",
        ...rpcCall(ctx, useCase),
      });
      await renderArchiveList(ctx, result);
      outcome = screenBoundary(result, {
        ok: ["archived-meetup-list"],
        okMessage: "archive list sent",
        rejectedMessage: "archive list rejected",
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
      action.kind === "manage-hold" ||
      action.kind === "manage-publish" ||
      action.kind === "manage-publish-later" ||
      action.kind === "manage-unschedule"
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
      } else if (action.kind === "manage-hold" && meetup.lifecycle === "held") {
        // Устаревшая кнопка: кто-то уже отметил сходку состоявшейся. Confirm
        // здесь был бы подтверждением действия, которое уже не изменит
        // состояние, — то же обращение со stale-кнопкой, что и у отмены выше.
        await editScreen(
          ctx,
          "Сходка уже отмечена состоявшейся.",
          new InlineKeyboard().text("Открыть сходку", `v1:view:${token}`),
        );
      } else if (
        action.kind === "manage-publish-later" &&
        meetup.visibility === "visible"
      ) {
        // Устаревшая кнопка (E-04): сходку уже опубликовали — вручную или по
        // расписанию. Вопрос о моменте здесь закончился бы отказом домена.
        await editScreen(
          ctx,
          "Сходка уже опубликована. Назначать публикацию больше не нужно.",
          new InlineKeyboard().text("Открыть сходку", `v1:view:${token}`),
        );
      } else if (action.kind === "manage-publish-later") {
        await renderFormResult(
          ctx,
          { kind: "ask-publish-moment", meetup },
          questions,
          runtime.presentation ?? "rich",
        );
      } else if (
        action.kind === "manage-unschedule" &&
        meetup.publishAt === undefined
      ) {
        await editScreen(
          ctx,
          "Отложенной публикации у сходки уже нет.",
          new InlineKeyboard().text("Открыть сходку", `v1:view:${token}`),
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
        const stateAction = stateActionByCallback[action.kind];
        // «Отметить состоявшейся» открывается с карточки напрямую, а не через
        // подменю статуса (PER-230), поэтому и отказ возвращает туда же.
        const back =
          action.kind === "manage-hold"
            ? `v1:view:${token}`
            : `v1:manage:status:${token}`;
        await editScreen(
          ctx,
          `Точно ${stateActionCopy[stateAction].verb} «${meetup.title}»?`,
          new InlineKeyboard()
            .text("Да, продолжить", confirmStateCallback(stateAction, token))
            .row()
            .text("Нет", back),
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
      action.kind === "manage-confirm-cancel" ||
      action.kind === "manage-confirm-hold" ||
      action.kind === "manage-confirm-unschedule"
    ) {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "change-meetup-state",
        action: stateActionByCallback[action.kind],
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
    if (
      action.kind === "notify-global" ||
      action.kind === "notify-set-global"
    ) {
      const result = await runtime.dispatcher.execute(
        action.kind === "notify-global"
          ? {
              identity: person,
              intent: "view-global-notifications",
              ...rpcCall(ctx, useCase),
            }
          : {
              identity: person,
              intent: "set-global-category",
              category: action.category,
              enabled: action.enabled,
              ...rpcCall(ctx, useCase),
            },
      );
      await renderNotificationSettings(ctx, result, "v1:notify:global");
      outcome = screenBoundary(result, {
        ok: ["global-notification-settings"],
        okMessage: "global notification settings sent",
        rejectedMessage: "global notification settings rejected",
        useCase,
      });
      return;
    }
    // Подписка меняет карточку, а не открывает кадр настроек: действие живёт в
    // P-04, и человек обязан остаться там же с обновлённой кнопкой.
    if (action.kind === "notify-subscription") {
      const meetupId = tokenToUuid(action.token);
      const result = await runtime.dispatcher.execute({
        identity: person,
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: action.subscribed,
        ...rpcCall(ctx, useCase),
      });
      if (result.kind === "meetup-card" || result.kind === "meetup-not-found") {
        await renderMeetupCard(
          ctx,
          result,
          true,
          runtime.presentation ?? "rich",
          person.globalRoles.includes("admin"),
        );
      } else {
        await renderNotificationFailure(ctx, result, `v1:view:${action.token}`);
      }
      outcome = screenBoundary(result, {
        ok: ["meetup-card"],
        okMessage: "meetup subscription changed",
        rejectedMessage: "meetup subscription rejected",
        useCase,
        meetupId,
      });
      return;
    }
    if (
      action.kind === "notify-settings" ||
      action.kind === "notify-set-meetup"
    ) {
      const meetupId = tokenToUuid(action.token);
      const call = { ...rpcCall(ctx, useCase) };
      const result = await runtime.dispatcher.execute(
        action.kind === "notify-settings"
          ? {
              identity: person,
              intent: "view-meetup-notifications",
              meetupId,
              ...call,
            }
          : {
              identity: person,
              intent: "set-meetup-category",
              meetupId,
              category: action.category,
              enabled: action.enabled,
              ...call,
            },
      );
      // Сходка могла исчезнуть между отрисовкой кнопки и нажатием: кадр
      // настроек читает её ради заголовка и отвечает тем же «не найдено», что и
      // карточка, а не пустым списком категорий.
      if (result.kind === "meetup-not-found") {
        await renderMeetupCard(
          ctx,
          result,
          true,
          runtime.presentation ?? "rich",
        );
      } else {
        await renderNotificationSettings(
          ctx,
          result,
          `v1:notify:settings:${action.token}`,
        );
      }
      outcome = screenBoundary(result, {
        ok: ["meetup-notification-settings"],
        okMessage: "meetup notification settings sent",
        rejectedMessage: "meetup notification settings rejected",
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

async function sendMaterialConfirmation(
  ctx: UpdateContext,
  meetupId: string,
  title: string,
  source: MaterialInputSource,
): Promise<void> {
  const meetupToken = uuidToToken(meetupId);
  const materialToken = uuidToToken(createUuidV7());
  const keyboard = new InlineKeyboard();
  if (source.kind === "message-link") {
    keyboard.url("Открыть источник", source.url).row();
  }
  keyboard
    .text("Прикрепить", `v1:mm:confirm-add:${meetupToken}:${materialToken}`)
    .text("Отмена", `v1:view:${meetupToken}`);
  const text = materialConfirmationText(title);
  if (source.kind === "message-link") {
    await ctx.reply(text, { reply_markup: keyboard });
  } else if (source.fileKind === "document") {
    await ctx.replyWithDocument(source.fileId, {
      caption: text,
      reply_markup: keyboard,
    });
  } else {
    await ctx.replyWithPhoto(source.fileId, {
      caption: text,
      reply_markup: keyboard,
    });
  }
}

async function sendStoredMaterialFile(
  ctx: UpdateContext,
  fileId: string,
  title: string,
): Promise<{ kind: "sent" } | { kind: "failed"; cause: unknown }> {
  try {
    await ctx.replyWithDocument(fileId, { caption: title });
    return { kind: "sent" };
  } catch (documentCause) {
    try {
      await ctx.replyWithPhoto(fileId, { caption: title });
      return { kind: "sent" };
    } catch (photoCause) {
      return {
        kind: "failed",
        cause: new AggregateError(
          [documentCause, photoCause],
          "Telegram could not send the stored material file",
        ),
      };
    }
  }
}

async function renderMaterialManagement(
  ctx: UpdateContext,
  meetup: MeetupSnapshot,
  canManage = true,
  requestedPage = 0,
): Promise<void> {
  const meetupToken = uuidToToken(meetup.id);
  const pageCount = Math.max(
    1,
    Math.ceil(meetup.materials.length / materialPageSize),
  );
  const page = Math.min(requestedPage, pageCount - 1);
  const pageStart = page * materialPageSize;
  const materials = meetup.materials.slice(
    pageStart,
    pageStart + materialPageSize,
  );
  const lines = [
    "Материалы сходки",
    meetup.title,
    ...(pageCount === 1 ? [] : [`Страница ${page + 1} из ${pageCount}`]),
    "",
    meetup.materials.length === 0
      ? "Пока ничего не прикреплено."
      : materials
          .map(
            (material, index) =>
              `${pageStart + index + 1}. ${displayMaterialTitle(material, pageStart + index + 1)}`,
          )
          .join("\n"),
  ];
  const keyboard = new InlineKeyboard();
  for (const [index, material] of materials.entries()) {
    const materialToken = uuidToToken(material.id);
    const title = buttonText(
      displayMaterialTitle(material, pageStart + index + 1),
    );
    if (material.source.kind === "message-link") {
      keyboard.url(title, material.source.url);
    } else {
      keyboard.text(title, `v1:mm:file:${meetupToken}:${materialToken}`);
    }
    if (canManage) {
      keyboard.text("Убрать", `v1:mm:rm:${meetupToken}:${materialToken}`);
    }
    keyboard.row();
  }
  if (pageCount > 1) {
    if (page > 0) {
      keyboard.text("←", `v1:mm:list:${meetupToken}:${page - 1}`);
    }
    if (page + 1 < pageCount) {
      keyboard.text("→", `v1:mm:list:${meetupToken}:${page + 1}`);
    }
    keyboard.row();
  }
  if (canManage) {
    keyboard.text("Прикрепить материал", `v1:mm:add:${meetupToken}`).row();
  }
  keyboard.text("К сходке", `v1:view:${meetupToken}`);
  await editScreen(ctx, lines.join("\n"), keyboard);
}

async function renderMaterialResult(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
): Promise<void> {
  if (result.kind === "material-attached") {
    await renderMaterialManagement(ctx, result.meetup);
    return;
  }
  if (result.kind === "material-removed") {
    await renderMaterialManagement(ctx, result.meetup);
    return;
  }
  const text =
    result.kind === "dependency-rejected" && result.reason === "forbidden"
      ? materialForbiddenText
      : result.kind === "dependency-rejected" && result.reason === "invalid"
        ? `Не получилось изменить материалы: ${result.message}`
        : unavailableText;
  await editScreen(
    ctx,
    text,
    new InlineKeyboard().text("К списку", "v1:nav:hub"),
  );
}

function materialForbiddenOutcome(
  person: Person,
  meetupId: string,
): BoundaryOutcome {
  return {
    level: "warn",
    message: "material management rejected",
    result: "error",
    use_case: "update_meetup",
    meetup_id: meetupId,
    identity_id: person.identityId,
    error_category: "authorization",
    error: "material_action_forbidden",
  };
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

async function renderArchiveList(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
): Promise<void> {
  if (result.kind === "archived-meetup-list") {
    const keyboard = archiveListKeyboard(result.meetups);
    const text =
      result.meetups.length === 0
        ? `Архив пока пуст.\n\nСюда попадают отменённые, состоявшиеся и прошедшие сходки.`
        : archiveListText(result.meetups);
    await editScreen(ctx, text, keyboard);
    return;
  }
  if (result.kind === "dependency-rejected" || result.kind === "rejected") {
    await editScreen(
      ctx,
      `Не получилось загрузить архив. Это на моей стороне.\n\nПопробуй ещё раз через минуту.`,
      new InlineKeyboard().text("Повторить", "v1:nav:archive"),
    );
  }
}

async function editScreen(
  ctx: UpdateContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    const message = ctx.callbackQuery?.message;
    if (
      message !== undefined &&
      ("document" in message || "photo" in message)
    ) {
      await ctx.editMessageCaption({ caption: text, reply_markup: keyboard });
    } else {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    }
  } catch (cause) {
    if (errorText(cause).includes("message is not modified")) {
      return;
    }
    await clearCallbackKeyboard(ctx);
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

async function clearCallbackKeyboard(ctx: UpdateContext): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  } catch {
    // A replacement screen still gets sent below; this is best-effort cleanup.
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

// Главный экран — ответ на /start. Возврат на него с других экранов правит то
// же сообщение той же клавиатурой, поэтому она собрана в одном месте.
function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ближайшие сходки", "v1:nav:hub")
    .text("Архив", "v1:nav:archive")
    .row()
    .text("Управление сходками", "v1:manage:menu");
}

function meetupListKeyboard(meetups: readonly MeetupSummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const meetup of meetups) {
    keyboard.text(meetup.title, `v1:view:${uuidToToken(meetup.id)}`).row();
  }
  return keyboard
    .text("Обновить", "v1:nav:hub")
    .text("Архив", "v1:nav:archive")
    .row()
    .text("Уведомления", "v1:notify:global")
    .row()
    .text("Назад", "v1:nav:start");
}

// Порядок задаёт Meetups (ListArchivedMeetups: новейшая дата первой, без даты —
// последними), поэтому список не группируется и не пересортировывается, в
// отличие от meetupListText.
function archiveListText(meetups: readonly ArchivedMeetupSummary[]): string {
  return ["Архив сходок", meetups.map(archivedMeetupListLine).join("\n")].join(
    "\n\n",
  );
}

function archivedMeetupListLine(meetup: ArchivedMeetupSummary): string {
  const label = scheduleLabel(meetup.schedule);
  const status = archiveStatusLabel(meetup.status);
  return label === undefined
    ? `• ${meetup.title} (${status})`
    : `• ${label} — ${meetup.title} (${status})`;
}

function archiveStatusLabel(status: ArchivedMeetupSummary["status"]): string {
  switch (status) {
    case "held":
      return "состоялась";
    case "cancelled":
      return "отменена";
    case "past":
      return "прошла";
  }
}

function archiveListKeyboard(
  meetups: readonly ArchivedMeetupSummary[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const meetup of meetups) {
    keyboard.text(meetup.title, `v1:view:${uuidToToken(meetup.id)}`).row();
  }
  return keyboard
    .text("Обновить", "v1:nav:archive")
    .text("Ближайшие сходки", "v1:nav:hub");
}

// Ярлыки повторяют строки макета P-07 дословно: экран настроек обязан называть
// категории теми же словами, что и продуктовая таблица, иначе «изменения»
// придётся сопоставлять по догадке.
const categoryLabels: Record<NotificationCategory, string> = {
  published: "Новые сходки",
  changes: "Изменения данных и статуса",
  material: "Новые связанные сообщения",
  reminder: "Напоминание перед началом",
  organizer: "Сообщения организатора",
  announcement: "Объявления сообщества",
};

function checkbox(label: string, enabled: boolean): string {
  return `${enabled ? "[x]" : "[ ]"} ${label}`;
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
    const token = uuidToToken(result.meetup.id);
    const keyboard = new InlineKeyboard();
    if (manageable && result.meetup.lifecycle !== "cancelled") {
      keyboard
        .text("Изменить", `v1:manage:edit:${token}`)
        .text("Статус", `v1:manage:status:${token}`)
        .row();
      if (result.meetup.lifecycle === "planned") {
        keyboard.text("Отметить состоявшейся", `v1:manage:hold:${token}`).row();
      }
      keyboard
        .text(
          `Материалы (${result.meetup.materials.length})`,
          `v1:mm:list:${token}`,
        )
        .row();
    } else if (result.meetup.materials.length > materialCardLimit) {
      keyboard
        .text(
          `Все материалы (${result.meetup.materials.length})`,
          `v1:mm:list:${token}`,
        )
        .row();
    }
    for (const [index, material] of result.meetup.materials
      .slice(0, materialCardLimit)
      .entries()) {
      if (material.source.kind === "file") {
        keyboard
          .text(
            buttonText(displayMaterialTitle(material, index + 1)),
            `v1:mm:file:${token}:${uuidToToken(material.id)}`,
          )
          .row();
      }
    }
    // Кнопка подписки рисуется только тогда, когда Notifications ответил:
    // состояние на ней — факт, а не заглушка, и выдуманное «выключены» человек
    // от настоящего не отличит. Вход в кадр настроек от этого не зависит и
    // остаётся всегда: иначе один моргнувший ответ отрезает экран целиком.
    if (result.subscribed !== undefined) {
      keyboard.text(
        result.subscribed ? "Отписаться" : "Подписаться",
        `v1:notify:sub:${token}:${result.subscribed ? "0" : "1"}`,
      );
    }
    keyboard.text("Уведомления", `v1:notify:settings:${token}`).row();
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
            await clearCallbackKeyboard(ctx);
            await ctx.replyWithRichMessage(richMessage, {
              reply_markup: keyboard,
            });
          }
        }
      } else {
        await ctx.replyWithRichMessage(richMessage, { reply_markup: keyboard });
      }
    } else {
      const html = meetupCardPlainHtml(result.meetup);
      if (edit) {
        try {
          await ctx.editMessageText(html, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch (cause) {
          if (!errorText(cause).includes("message is not modified")) {
            await clearCallbackKeyboard(ctx);
            await ctx.reply(html, {
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
          }
        }
      } else {
        await ctx.reply(html, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      }
    }
    return;
  }
  const keyboard = new InlineKeyboard().text("Повторить", "v1:nav:hub");
  if (edit) await editScreen(ctx, unavailableText, keyboard);
  else await ctx.reply(unavailableText, { reply_markup: keyboard });
}

// Оба кадра настроек живут в одном рендере: у них одна механика — список
// отметок, переключение на месте, `answerCallbackQuery` уже отправлен выше — и
// различаются только словарём категорий, заголовком и кнопкой возврата.
async function renderNotificationSettings(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  retry: string,
): Promise<void> {
  if (result.kind === "global-notification-settings") {
    const keyboard = new InlineKeyboard();
    for (const entry of result.categories) {
      keyboard
        .text(
          checkbox(categoryLabels[entry.category], entry.enabled),
          `v1:notify:gset:${entry.category}:${entry.enabled ? "0" : "1"}`,
        )
        .row();
    }
    keyboard.text("К списку", "v1:nav:hub");
    await editScreen(
      ctx,
      `Уведомления: общие настройки

Отметь, о чём присылать. Настройка действует для всех сходок, включая будущие. Категории, закреплённые отдельно у сходки, она уже не меняет.`,
      keyboard,
    );
    return;
  }
  if (result.kind === "meetup-notification-settings") {
    const token = uuidToToken(result.meetup.id);
    const keyboard = new InlineKeyboard();
    for (const entry of result.categories) {
      const label = checkbox(categoryLabels[entry.category], entry.enabled);
      keyboard
        .text(
          entry.differsFromGlobal ? `${label} · отличается` : label,
          `v1:notify:set:${token}:${entry.category}:${entry.enabled ? "0" : "1"}`,
        )
        .row();
    }
    // Подписки здесь нет намеренно: действие живёт в карточке P-04, и макет
    // этого экрана его не показывает. Состояние подписки кадр называет
    // текстом, чтобы отметки категорий не читались как «придёт всё это».
    keyboard.text("Назад", `v1:view:${token}`);
    const lines = [
      `Уведомления: ${result.meetup.title}`,
      "",
      result.subscribed
        ? "Ты следишь за этой сходкой."
        : "Ты за этой сходкой не следишь: придут только те уведомления, которым подписка не нужна. Подписаться можно из карточки.",
      "",
      "Отметь, о чём присылать. Настройка действует только для этой сходки.",
      // Следствие принятого контракта, названное человеку до нажатия, а не
      // после: операции снятия переопределения на проводе нет, и вернуть
      // «как везде» изнутри кадра будет уже нельзя.
      "Переключение здесь закрепляет значение за этой сходкой: общая настройка его больше не меняет.",
    ];
    if (result.categories.some((entry) => entry.differsFromGlobal)) {
      lines.push(
        "Отметка «отличается» значит, что значение не совпадает с общей настройкой.",
      );
    }
    await editScreen(ctx, lines.join("\n"), keyboard);
    return;
  }
  await renderNotificationFailure(ctx, result, retry);
}

// Отказ Notifications отвечает кадром по природе отказа, а не одним «сбой на
// моей стороне»: бриф компонента обещает разные кадры, и «Повторить» на отказе
// по праву или на устаревшем экране не лечит ничего.
async function renderNotificationFailure(
  ctx: UpdateContext,
  result: Awaited<ReturnType<Dispatcher["execute"]>>,
  retry: string,
): Promise<void> {
  if (result.kind === "dependency-rejected" && result.reason === "forbidden") {
    await editScreen(
      ctx,
      "Notifications не разрешил это действие.",
      new InlineKeyboard().text("К списку", "v1:nav:hub"),
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "invalid") {
    // Кнопка, которую сервис не принял, построена по устаревшему экрану:
    // перерисовка по текущему состоянию, а не повтор того же нажатия.
    await editScreen(
      ctx,
      "Этот экран устарел. Открой настройки заново.",
      new InlineKeyboard().text("Обновить", retry),
    );
    return;
  }
  if (result.kind === "dependency-rejected" && result.reason === "conflict") {
    await editScreen(
      ctx,
      "Это уже сделано. Ничего не изменилось.",
      new InlineKeyboard().text("Обновить", retry),
    );
    return;
  }
  await editScreen(
    ctx,
    unavailableText,
    new InlineKeyboard().text("Повторить", retry),
  );
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
    // Отложенность — выбор момента внутри публикации, а не отдельный
    // сценарий (ADR-024): кнопка стоит рядом с «Опубликовать», а назначенный
    // момент меняется тем же вопросом.
    keyboard
      .text(
        meetup.publishAt === undefined
          ? "Опубликовать позже"
          : "Перенести публикацию",
        `v1:manage:publish-later:${token}`,
      )
      .row();
    if (meetup.publishAt !== undefined) {
      keyboard
        .text(stateActionCopy.unschedule.label, `v1:manage:unschedule:${token}`)
        .row();
    }
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
        : result.reason === "not-scheduled"
          ? "Отложенной публикации у сходки уже нет."
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
  if (result.kind === "conflict" && result.action !== undefined) {
    const token = uuidToToken(result.meetup.id);
    const copy = stateActionCopy[result.action];
    await editScreen(
      ctx,
      `${conflictText}\n\nПроверь данные и подтверди действие ещё раз.`,
      new InlineKeyboard().text(
        copy.label,
        confirmStateCallback(result.action, token),
      ),
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
  const lines = meetupCardText(meetup, false).split("\n");
  const title = escapeHtml(lines.shift() ?? "");
  return `<h1>${title}</h1><p>${lines.map(escapeHtml).join("<br>")}${materialHtml(meetup)}</p>`;
}

function meetupCardPlainHtml(meetup: MeetupSnapshot): string {
  const lines = meetupCardText(meetup, false).split("\n");
  const title = escapeHtml(lines.shift() ?? "");
  return `<b>${title}</b>\n${lines.map(escapeHtml).join("\n")}${materialHtml(meetup, "\n")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function meetupCardText(
  meetup: MeetupSnapshot,
  includeMaterials = true,
): string {
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
  // Назначенный момент стоит сразу под статусом: «скрыта» без него читается
  // как «черновик забыт», а с ним — как «ждёт публикации».
  const pending =
    meetup.publishAt === undefined
      ? ""
      : `\nПубликация назначена на ${formatLocalMoment(meetup.publishAt)}`;
  const card = `${meetup.title}\nСтатус: ${lifecycle}, ${visibility}${pending}\n\nКогда: ${when}\nГде: ${venue}\n\n${description}`;
  if (!includeMaterials || meetup.materials.length === 0) return card;
  const materials = meetup.materials
    .slice(0, materialCardLimit)
    .map(
      (material, index) =>
        `${index + 1}. ${displayMaterialTitle(material, index + 1)}`,
    )
    .join("\n");
  return `${card}\n\nМатериалы:\n${materials}${materialOverflowText(meetup)}`;
}

function materialHtml(meetup: MeetupSnapshot, separator = "<br>"): string {
  if (meetup.materials.length === 0) return "";
  const materials = meetup.materials
    .slice(0, materialCardLimit)
    .map((material, index) => {
      const label = escapeHtml(displayMaterialTitle(material, index + 1));
      return material.source.kind === "message-link"
        ? `${index + 1}. <a href="${escapeHtml(material.source.url)}">${label}</a>`
        : `${index + 1}. ${label} (файл)`;
    });
  return `${separator}${separator}Материалы:${separator}${materials.join(separator)}${materialOverflowHtml(meetup, separator)}`;
}

function materialTitle(material: MeetupMaterial, index: number): string {
  const title = material.title.trim();
  return title === "" ? `Материал ${index}` : title;
}

function displayMaterialTitle(material: MeetupMaterial, index: number): string {
  const title = materialTitle(material, index);
  return title.length <= materialDisplayTitleLimit
    ? title
    : `${title.slice(0, materialDisplayTitleLimit - 1)}…`;
}

function materialOverflowText(meetup: MeetupSnapshot): string {
  const hidden = meetup.materials.length - materialCardLimit;
  return hidden > 0 ? `\n…и ещё ${hidden}. Открой раздел «Материалы».` : "";
}

function materialOverflowHtml(
  meetup: MeetupSnapshot,
  separator: string,
): string {
  const hidden = meetup.materials.length - materialCardLimit;
  return hidden > 0
    ? `${separator}…и ещё ${hidden}. Открой раздел «Материалы».`
    : "";
}

function buttonText(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}…`;
}

function meetupListLine(meetup: MeetupSummary): string {
  const label = scheduleLabel(meetup.schedule);
  return label === undefined
    ? `• ${meetup.title}`
    : `• ${label} — ${meetup.title}`;
}

function scheduleLabel(
  schedule: MeetupSummary["schedule"],
): string | undefined {
  if (schedule === undefined) return undefined;
  const { year, month, day } = schedule;
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
  return `${day} ${monthLabel}, ${weekdayLabel}`;
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
        reply_markup: new InlineKeyboard()
          .text("Опубликовать", `v1:manage:publish:${uuidToToken(meetup.id)}`)
          .row()
          .text(
            "Опубликовать позже",
            `v1:manage:publish-later:${uuidToToken(meetup.id)}`,
          ),
      },
    );
    return;
  }
  if (result.kind === "ask-publish-moment") {
    const token = uuidToToken(result.meetup.id);
    const current =
      result.meetup.publishAt === undefined
        ? ""
        : `Сейчас назначено: ${formatLocalMoment(result.meetup.publishAt)}\n`;
    const prompt =
      result.retry === undefined
        ? publishMomentPrompt
        : publishMomentRetryText[result.retry];
    const message = await ctx.reply(
      publishMomentQuestionText(`${current}${prompt}`, token),
      { reply_markup: { force_reply: true, selective: true } },
    );
    questions.set(questionKey(ctx.chat?.id, message.message_id), {
      kind: "publish-moment",
      meetupId: result.meetup.id,
      telegramUserId: ctx.from?.id ?? 0,
      expiresAt: Date.now() + questionTtlMs,
    });
    evictOldestQuestions(questions);
    return;
  }
  if (result.kind === "publication-scheduled") {
    // О самом срабатывании бот не рассказывает: уведомление о публикации —
    // блок Notifications. Здесь только подтверждение назначения.
    await ctx.reply(
      result.meetup.publishAt === undefined
        ? "Публикация назначена."
        : `Публикация назначена на ${formatLocalMoment(result.meetup.publishAt)}. До этого момента сходка остаётся скрытой.`,
    );
    await renderMeetupCard(
      ctx,
      { kind: "meetup-card", meetup: result.meetup },
      false,
      presentation,
      true,
    );
    return;
  }
  if (result.kind === "publication-unavailable") {
    // E-04: ответ по текущему состоянию, а не по экрану, с которого пришёл ввод.
    const text =
      result.meetup.lifecycle === "cancelled"
        ? "Сходка отменена. Назначить ей публикацию нельзя."
        : "Сходка уже опубликована. Назначать публикацию больше не нужно.";
    await ctx.reply(text);
    await renderMeetupCard(
      ctx,
      { kind: "meetup-card", meetup: result.meetup },
      false,
      presentation,
      true,
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
    | "home"
    | "hub"
    | "archive"
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
    | "manage-confirm-cancel"
    | "notify-global"
    | "notify-set-global"
    | "notify-settings"
    | "notify-subscription"
    | "notify-set-meetup"
    | "manage-hold"
    | "manage-confirm-hold"
    | "manage-publish-later"
    | "manage-unschedule"
    | "manage-confirm-unschedule"
    | "manage-materials"
    | "begin-attach-material"
    | "confirm-attach-material"
    | "remove-material"
    | "confirm-remove-material"
    | "open-material-file",
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
    case "manage-hold":
    case "manage-confirm-hold":
    case "manage-publish-later":
    case "manage-unschedule":
    case "manage-confirm-unschedule":
    case "manage-materials":
    case "begin-attach-material":
    case "confirm-attach-material":
    case "remove-material":
    case "confirm-remove-material":
      return "update_meetup";
    case "open-material-file":
      return "view_meetup";
    case "community":
    case "ask-allowed-username":
    case "admit-member":
    case "block-member":
    case "remove-allowed-username":
      return "manage_community";
    case "notify-global":
    case "notify-set-global":
    case "notify-settings":
    case "notify-subscription":
    case "notify-set-meetup":
      return "manage_notifications";
    case "home":
    case "hub":
    case "archive":
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
  meetupId?: string,
  identityId?: string,
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
  if (meetupId !== undefined) {
    outcome.meetup_id = meetupId;
  }
  if (identityId !== undefined) {
    outcome.identity_id = identityId;
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
