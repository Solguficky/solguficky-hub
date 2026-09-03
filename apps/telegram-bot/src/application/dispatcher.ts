import { acknowledge } from "./acknowledge.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

export type Dispatcher = {
  execute(request: ExecuteRequest): ExecuteResult;
};

export function createDispatcher(): Dispatcher {
  return {
    execute(request) {
      switch (request.intent) {
        case "acknowledge":
          return acknowledge(request);
        default: {
          const _exhaustive: never = request.intent;
          return unknownIntent(_exhaustive);
        }
      }
    },
  };
}

function unknownIntent(_intent: never): ExecuteResult {
  return { kind: "rejected", reason: "unknown-intent" };
}
