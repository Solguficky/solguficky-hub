import { MtTimeoutError, TransportError, tl } from "@mtcute/node";
import { MissingSecretError } from "./session.js";

// Живой контур падает с названной причиной, а не пропускается
// (testing-strategy.md, «Пропуск не равен прохождению»): владелец по первой
// строке отличает внешнюю причину — флуд-лимит, недоступный Telegram — от
// поломки бота.

export type FailureKind =
  | "missing-secret"
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

function networkCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; depth < 5; depth += 1) {
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

/** Переводит отказ драйвера в причину, которую печатает упавший прогон. */
export function classifyFailure(error: unknown): TelegramLiveFailure {
  if (error instanceof TelegramLiveFailure) {
    return error;
  }
  if (error instanceof MissingSecretError) {
    return new TelegramLiveFailure("missing-secret", error.message, {
      cause: error,
    });
  }
  if (tl.RpcError.is(error)) {
    if (error.is("FLOOD_WAIT_%d")) {
      return new TelegramLiveFailure(
        "flood-wait",
        `Telegram требует подождать ${error.seconds} с; повтор раньше продлит ограничение`,
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
