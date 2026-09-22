import { z } from "zod";
import type { MeetupMaterialSource } from "../meetups/port.js";

const FileSchema = z.object({ file_id: z.string().min(1) });
const MaterialInputSchema = z.object({
  document: FileSchema.optional(),
  photo: z.array(FileSchema).min(1).optional(),
  forward_origin: z
    .object({
      type: z.string(),
      chat: z
        .object({ id: z.number().int(), username: z.string().optional() })
        .optional(),
      message_id: z.number().int().positive().optional(),
    })
    .optional(),
});

const ConfirmationSchema = z.object({
  text: z.string().optional(),
  caption: z.string().optional(),
  document: FileSchema.optional(),
  photo: z.array(FileSchema).min(1).optional(),
  reply_markup: z
    .object({
      inline_keyboard: z.array(
        z.array(z.object({ url: z.string().url().optional() })),
      ),
    })
    .optional(),
});

const confirmationPrefix = "Прикрепить материал?\n\nНазвание: ";

export type PendingMaterialSource =
  | { kind: "message-link"; url: string }
  | { kind: "file"; fileId: string; fileKind: "document" | "photo" };

export type MaterialConfirmation = {
  title: string;
  source: MeetupMaterialSource;
};

export function parseMaterialInput(
  raw: unknown,
): PendingMaterialSource | undefined {
  const parsed = MaterialInputSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const origin = parsed.data.forward_origin;
  if (
    origin?.type === "channel" &&
    origin.chat !== undefined &&
    origin.message_id !== undefined
  ) {
    const chat = origin.chat;
    const url =
      chat.username === undefined
        ? privateMessageUrl(chat.id, origin.message_id)
        : `https://t.me/${chat.username}/${origin.message_id}`;
    if (url !== undefined) return { kind: "message-link", url };
  }
  if (parsed.data.document !== undefined) {
    return {
      kind: "file",
      fileId: parsed.data.document.file_id,
      fileKind: "document",
    };
  }
  const photo = parsed.data.photo?.at(-1);
  if (photo !== undefined) {
    return { kind: "file", fileId: photo.file_id, fileKind: "photo" };
  }
  return undefined;
}

export function materialConfirmationText(title: string): string {
  return `${confirmationPrefix}${title}`;
}

export function parseMaterialConfirmation(
  raw: unknown,
): MaterialConfirmation | undefined {
  const parsed = ConfirmationSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const label = parsed.data.caption ?? parsed.data.text;
  if (label === undefined || !label.startsWith(confirmationPrefix)) {
    return undefined;
  }
  const title = label.slice(confirmationPrefix.length).trim();
  if (title === "") return undefined;
  const document = parsed.data.document;
  if (document !== undefined) {
    return { title, source: { kind: "file", fileId: document.file_id } };
  }
  const photo = parsed.data.photo?.at(-1);
  if (photo !== undefined) {
    return { title, source: { kind: "file", fileId: photo.file_id } };
  }
  const url = parsed.data.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.url?.startsWith("https://t.me/"))?.url;
  return url === undefined
    ? undefined
    : { title, source: { kind: "message-link", url } };
}

function privateMessageUrl(
  chatId: number,
  messageId: number,
): string | undefined {
  const encoded = String(chatId);
  if (!encoded.startsWith("-100") || encoded.length <= 4) return undefined;
  return `https://t.me/c/${encoded.slice(4)}/${messageId}`;
}
