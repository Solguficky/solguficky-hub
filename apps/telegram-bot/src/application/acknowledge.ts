import type { ExecuteRequest, ExecuteResult } from "./types.js";

const stubText = "заглушка";

export function acknowledge(_request: ExecuteRequest): ExecuteResult {
  return { kind: "stub", text: stubText };
}
