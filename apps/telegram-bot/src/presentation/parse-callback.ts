import { z } from "zod";
import type { FormField } from "../application/types.js";

const CallbackSchema = z.string().max(64);
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const FormFieldSchema = z.enum(["title", "schedule", "venue", "description"]);

// Ник едет в `callback_data` как есть, и обратно он доезжает только в этом
// алфавите и в этой длине: у Telegram на данные кнопки 64 байта, а длиннее 32
// символов ника не бывает. Экран сверяется с тем же выражением, что и разбор:
// кнопка, которую разбор потом назовёт сломанной, рисоваться не должна.
export const removableUsernamePattern = /^[A-Za-z0-9_]{1,32}$/;

export type CallbackAction =
  | { kind: "hub" }
  | { kind: "manage-menu" }
  | { kind: "community" }
  | { kind: "ask-allowed-username" }
  | { kind: "admit-member"; token: string }
  | { kind: "block-member"; token: string }
  | { kind: "remove-allowed-username"; username: string }
  | { kind: "create-meetup"; token: string }
  | { kind: "publish-meetup"; token: string }
  | { kind: "manage-edit"; token: string }
  | { kind: "manage-field"; token: string; field: FormField }
  | { kind: "manage-status"; token: string }
  | { kind: "manage-publish"; token: string }
  | { kind: "manage-unpublish"; token: string }
  | { kind: "manage-confirm-unpublish"; token: string }
  | { kind: "manage-cancel"; token: string }
  | { kind: "manage-confirm-cancel"; token: string }
  | { kind: "manage-materials"; token: string; page?: number }
  | { kind: "begin-attach-material"; token: string }
  | { kind: "confirm-attach-material"; token: string; materialToken: string }
  | { kind: "remove-material"; token: string; materialToken: string }
  | { kind: "confirm-remove-material"; token: string; materialToken: string }
  | { kind: "open-material-file"; token: string; materialToken: string }
  | { kind: "view-meetup"; token: string }
  | { kind: "outdated" }
  | { kind: "malformed" };

export function parseCallback(raw: unknown): CallbackAction {
  const parsed = CallbackSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed" };
  const parts = parsed.data.split(":");
  if (parts[0] !== "v1") return { kind: "outdated" };
  if (parsed.data === "v1:manage:menu") return { kind: "manage-menu" };
  if (parsed.data === "v1:community:list") return { kind: "community" };
  if (parsed.data === "v1:community:allow")
    return { kind: "ask-allowed-username" };
  if (parsed.data === "v1:nav:hub") return { kind: "hub" };
  if (parts.length === 3 && parts[1] === "view") {
    const viewToken = TokenSchema.safeParse(parts[2]);
    return viewToken.success
      ? { kind: "view-meetup", token: viewToken.data }
      : { kind: "malformed" };
  }
  if (parts[1] === "mm") {
    const meetupToken = TokenSchema.safeParse(parts[3]);
    if (!meetupToken.success) return { kind: "malformed" };
    if ((parts.length === 4 || parts.length === 5) && parts[2] === "list") {
      if (parts[4] === undefined) {
        return { kind: "manage-materials", token: meetupToken.data };
      }
      const page = z.coerce.number().int().nonnegative().safeParse(parts[4]);
      return page.success
        ? { kind: "manage-materials", token: meetupToken.data, page: page.data }
        : { kind: "malformed" };
    }
    if (parts.length === 4 && parts[2] === "add") {
      return { kind: "begin-attach-material", token: meetupToken.data };
    }
    const materialToken = TokenSchema.safeParse(parts[4]);
    if (!materialToken.success || parts.length !== 5) {
      return { kind: "malformed" };
    }
    switch (parts[2]) {
      case "confirm-add":
        return {
          kind: "confirm-attach-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "rm":
        return {
          kind: "remove-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "confirm-rm":
        return {
          kind: "confirm-remove-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "file":
        return {
          kind: "open-material-file",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      default:
        return { kind: "malformed" };
    }
  }
  if (parts.length === 4 && parts[1] === "community") {
    const username = parts[3] ?? "";
    if (parts[2] === "remove" && removableUsernamePattern.test(username)) {
      return { kind: "remove-allowed-username", username };
    }
    const identityToken = TokenSchema.safeParse(parts[3]);
    if (!identityToken.success) return { kind: "malformed" };
    if (parts[2] === "admit")
      return { kind: "admit-member", token: identityToken.data };
    if (parts[2] === "block")
      return { kind: "block-member", token: identityToken.data };
  }
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success || parts[1] !== "manage") {
    return { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "new")
    return { kind: "create-meetup", token: token.data };
  if (parts.length === 4 && parts[2] === "publish")
    return { kind: "publish-meetup", token: token.data };
  if (parts.length === 4 && parts[2] === "edit")
    return { kind: "manage-edit", token: token.data };
  if (parts.length === 5 && parts[2] === "field") {
    const field = FormFieldSchema.safeParse(parts[4]);
    return field.success
      ? { kind: "manage-field", token: token.data, field: field.data }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "status")
    return { kind: "manage-status", token: token.data };
  if (parts.length === 4 && parts[2] === "republish")
    return { kind: "manage-publish", token: token.data };
  if (parts.length === 4 && parts[2] === "unpublish")
    return { kind: "manage-unpublish", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-unpublish")
    return { kind: "manage-confirm-unpublish", token: token.data };
  if (parts.length === 4 && parts[2] === "cancel")
    return { kind: "manage-cancel", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-cancel")
    return { kind: "manage-confirm-cancel", token: token.data };
  return { kind: "malformed" };
}
