import { MtTimeoutError, TransportError, tl } from "@mtcute/node";
import { SecretError } from "./session.js";

// Живой контур падает с названной причиной, а не пропускается
// (testing-strategy.md, «Пропуск не равен прохождению»): владелец по первой
// строке отличает внешнюю причину — флуд-лимит, недоступный Telegram — от
// поломки бота.

export type FailureKind =
  | "missing-secret"
  | "invalid-secret"
  | "flood-wait"
  | "session-invalid"
  | "telegram-unreachable"
  | "not-test-environment"
  | "bot-no-reply"
  | "unknown";

export class TelegramLiveFailure extends Error {
  readonly kind: FailureKind;

  constructor(
    kind: FailureKind,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${kind}: ${detail}`, options);
    this.name = "TelegramLiveFailure";
    this.kind = kind;
  }
}

const sessionErrors = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);

const networkErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// Сетевой код лежит в `cause` одной-двух обёрток; предел держит обход конечным
// на циклической цепочке причин.
const maxCauseDepth = 5;

function networkCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; depth < maxCauseDepth; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string" && networkErrorCodes.has(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function floodSeconds(error: tl.RpcError): number | undefined {
  const parsed: unknown = (error as { seconds?: unknown }).seconds;
  if (typeof parsed === "number") {
    return parsed;
  }
  const match = /_(\d+)$/.exec(error.text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Переводит отказ драйвера в причину, которую печатает упавший прогон. */
export function classifyFailure(error: unknown): TelegramLiveFailure {
  if (error instanceof TelegramLiveFailure) {
    return error;
  }
  if (error instanceof SecretError) {
    return new TelegramLiveFailure(
      error.problem === "missing" ? "missing-secret" : "invalid-secret",
      error.message,
      { cause: error },
    );
  }
  if (tl.RpcError.is(error)) {
    // Код 420 — любой флуд-лимит: FLOOD_WAIT, FLOOD_PREMIUM_WAIT, SLOWMODE_WAIT
    // и FLOOD_TEST_PHONE_WAIT; последний mtcute в `seconds` не разбирает.
    if (error.code === tl.RpcError.FLOOD) {
      const seconds = floodSeconds(error);
      return new TelegramLiveFailure(
        "flood-wait",
        `${error.text}: Telegram требует подождать ${seconds ?? "неизвестно сколько"} с; ` +
          "повтор раньше продлит ограничение",
        { cause: error },
      );
    }
    if (sessionErrors.has(error.text)) {
      return new TelegramLiveFailure(
        "session-invalid",
        `${error.text}: сессия отозвана или аккаунт удалён, получи новую just telegram-live-login`,
        { cause: error },
      );
    }
    return new TelegramLiveFailure("unknown", error.message, { cause: error });
  }
  if (error instanceof TransportError) {
    return new TelegramLiveFailure(
      "telegram-unreachable",
      `транспорт MTProto отказал с кодом ${error.code}`,
      { cause: error },
    );
  }
  const code = networkCode(error);
  if (code !== undefined) {
    return new TelegramLiveFailure(
      "telegram-unreachable",
      `сетевая ошибка ${code} при соединении с тестовым DC`,
      { cause: error },
    );
  }
  if (error instanceof MtTimeoutError) {
    return new TelegramLiveFailure("telegram-unreachable", error.message, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TelegramLiveFailure("unknown", message, { cause: error });
}
