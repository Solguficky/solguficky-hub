import type { FailureCategory } from "../../../core/failures.js";

// Категории отказов сервисов для записи границы (logging.md): общие у
// обработчиков лички и у шёпота в чате сообщества.

export function grpcFailureCategory(code: string): FailureCategory {
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

export function dependencyCategory(reason: string): FailureCategory {
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

export function unavailableCategory(cause: unknown): FailureCategory {
  const text = (
    cause instanceof Error ? cause.message : String(cause)
  ).toLowerCase();
  return text.includes("deadline") || text.includes("timeout")
    ? "timeout"
    : "dependency_unavailable";
}
