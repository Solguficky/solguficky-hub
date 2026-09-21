import type { FormField } from "../application/types.js";
import { parseCallback } from "./parse-callback.js";

const marker = "Шаг: ";

export function editQuestionText(
  prompt: string,
  token: string,
  field: FormField,
): string {
  return `${prompt}\n\n${marker}v1:manage:field:${token}:${field}`;
}

export function parseEditQuestion(
  text: unknown,
): { token: string; field: FormField } | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n").at(-1);
  if (line === undefined || !line.startsWith(marker)) return undefined;
  const action = parseCallback(line.slice(marker.length));
  return action.kind === "manage-field"
    ? { token: action.token, field: action.field }
    : undefined;
}
