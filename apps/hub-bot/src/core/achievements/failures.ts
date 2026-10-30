import { Code, ConnectError } from "@connectrpc/connect";
import { ZodError } from "zod";
import { countFailure, type FailureCategory } from "../failures.js";
import type { Logger } from "../logging.js";
import type { RpcMetadata } from "../rpc-metadata.js";

export class AchievementsInvariant extends Error {}

export function reportAchievementsFailure(input: {
  logger: Logger;
  cause: unknown;
  meta?: RpcMetadata;
}): void {
  const { cause, meta } = input;
  const category: FailureCategory =
    cause instanceof ConnectError
      ? cause.code === Code.DeadlineExceeded
        ? "timeout"
        : "dependency_unavailable"
      : cause instanceof AchievementsInvariant || cause instanceof ZodError
        ? "invariant"
        : "unexpected";
  countFailure(category);
  input.logger.warn("achievement screen unavailable", {
    ...(meta?.requestId === undefined ? {} : { request_id: meta.requestId }),
    error_category: category,
    error: cause instanceof Error ? cause.message : String(cause),
    ...(category === "unexpected" &&
    cause instanceof Error &&
    cause.stack !== undefined
      ? { stack: cause.stack }
      : {}),
  });
}
