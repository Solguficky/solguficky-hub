import type { TelegramRecipientResult } from "./port.js";

// Коды gRPC, отказ по которым не пройдёт и со второй попытки: нарушение
// контракта, рассинхрон схемы, отсутствующий метод. Всё остальное —
// недоступность зависимости, где повтор осмыслен. Числа — коды gRPC, их же
// несёт `code` у ConnectError: пакет Connect не тянет, как и grammY.
const permanentCodes: ReadonlyMap<number, string> = new Map([
  [3, "InvalidArgument"],
  [5, "NotFound"],
  [6, "AlreadyExists"],
  [7, "PermissionDenied"],
  [9, "FailedPrecondition"],
  [11, "OutOfRange"],
  [12, "Unimplemented"],
  [16, "Unauthenticated"],
]);

const notFound = 5;
const failedPrecondition = 9;

function grpcCode(cause: unknown): number | undefined {
  return cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "number"
    ? cause.code
    : undefined;
}

// Отказ `ResolveTelegramUserId`: неизвестный профиль приходит `NOT_FOUND`,
// заблокированный — `FAILED_PRECONDITION`. Оба окончательные, но различимы в
// журнале и логах.
export function classifyRecipientFailure(
  cause: unknown,
): TelegramRecipientResult {
  const code = grpcCode(cause);
  if (code === notFound) return { kind: "not-found" };
  if (code === failedPrecondition) return { kind: "blocked" };
  const name = code === undefined ? undefined : permanentCodes.get(code);
  if (name !== undefined) return { kind: "rejected", code: name, cause };
  return { kind: "unavailable", cause };
}

// Отказ вызова, у которого нет своих окончательных исходов: постоянный код
// — отказ, остальное — недоступность.
export function isPermanentFailure(cause: unknown): boolean {
  const code = grpcCode(cause);
  return code !== undefined && permanentCodes.has(code);
}
