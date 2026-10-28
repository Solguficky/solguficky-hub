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

const confirmationQuestion = "Прикрепить материал?";
const confirmationPrefix = `${confirmationQuestion}\n\nНазвание: `;

export type PendingMaterialSource = MeetupMaterialSource;

export type MaterialConfirmation = {
  title: string;
  source: MeetupMaterialSource;
};

const TypedTextSchema = z.object({
  text: z.string(),
  forward_origin: z.undefined().optional(),
});

/**
 * Набранный текст, а не пересланное сообщение: у него нет источника, и отказ
 * про скрытый источник ему не подходит (прогон 14.10, №99).
 */
export function isTypedText(raw: unknown): boolean {
  return TypedTextSchema.safeParse(raw).success;
}

// Ссылка «Копировать ссылку» клиента Telegram: публичный чат по имени или
// закрытый по номеру `c/<чат>`, необязательная тема и номер сообщения.
// Схема необязательна, `http://` тоже принимается (PER-793): ссылку набирают
// и руками. Ссылка собирается заново из разобранных частей, а не уезжает в
// материал как набрана: схема всегда `https://`, из хвоста запроса остаётся
// только `comment` — он ведёт на комментарий, а не на сам пост, — а `?single`
// и прочее отбрасываются.
const linkBody =
  "t\\.me\\/(?:c\\/([1-9]\\d*)|([A-Za-z][A-Za-z0-9_]{3,31}))(?:\\/([1-9]\\d*))?\\/([1-9]\\d*)";
// Регистр не важен: клавиатура телефона пишет первую букву заглавной.
const MessageLinkPattern = new RegExp(
  `^(?:https?:\\/\\/)?${linkBody}\\/?(?:\\?(\\S*))?$`,
  "i",
);
// Знак препинания после ссылки, набранной руками, частью ссылки не считается.
const TrailingPunctuation = /[.,!;:)]+$/;
// Та же ссылка внутри фразы: материалом фраза не становится — набранный текст
// без ответа бывает подписью к пересылке, — но отказ называет, что ссылку
// нужно прислать одну.
const LinkInPhrasePattern = new RegExp(
  `(?:^|[^\\w./])(?:https?:\\/\\/)?${linkBody}(?!\\w)`,
  "i",
);
const CommentIdPattern = /^[1-9]\d*$/;

/**
 * Пересылка из группы чат и номер сообщения не несёт, поэтому сообщение чата
 * приходит набранной ссылкой на него (PER-762).
 */
function parseMessageLink(raw: unknown): string | undefined {
  const parsed = TypedTextSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const match = MessageLinkPattern.exec(
    parsed.data.text.trim().replace(TrailingPunctuation, ""),
  );
  if (match === null) return undefined;
  const [, chatId, username, topicId, messageId, query] = match;
  const chat = chatId === undefined ? username : `c/${chatId}`;
  const topic = topicId === undefined ? "" : `/${topicId}`;
  const commentId = new URLSearchParams(query ?? "").get("comment");
  const comment =
    commentId !== null && CommentIdPattern.test(commentId)
      ? `?comment=${commentId}`
      : "";
  return `https://t.me/${chat}${topic}/${messageId}${comment}`;
}

// GIF в списке нет: Bot API кладёт у него и `document`, и он, как прежде,
// становится документом. Место идёт раньше геопозиции: у `venue` заполнено и
// `location`.
const unsupportedKinds = [
  ["video", "Видео"],
  ["video_note", "Кружок"],
  ["voice", "Голосовое"],
  ["audio", "Аудио"],
  ["sticker", "Стикер"],
  ["poll", "Опрос"],
  ["venue", "Место"],
  ["location", "Геопозиция"],
  ["contact", "Контакт"],
  ["dice", "Кубик"],
] as const;

const forwardTypes = new Set(["user", "hidden_user", "chat", "channel"]);

export type MaterialRefusal = {
  // Вид сообщения для записи отказа — `forward:<тип>`, вид медиа, `text` или
  // `other`, у пересланного медиа через запятую. Содержимого в нём нет.
  kind: string;
  text: string;
};

/**
 * Почему сообщение не стало материалом. Пересылка из группы получает подсказку
 * про ссылку: Bot API не даёт у неё чат и номер, и «источник скрыт» был бы
 * неправдой (прод, 27.10.2026).
 */
export function materialRefusal(raw: unknown): MaterialRefusal {
  const message =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const origin = z
    .object({ type: z.string() })
    .safeParse(message["forward_origin"]);
  // Тип вне словаря Bot API в запись не попадает как есть.
  const forward = origin.success
    ? forwardTypes.has(origin.data.type)
      ? origin.data.type
      : "other"
    : undefined;
  const media = unsupportedKinds.find(([key]) => message[key] !== undefined);
  if (forward === undefined) {
    if (media !== undefined) {
      return {
        kind: media[0],
        text: `${media[1]} не принимается материалом: нужна фотография, документ, ссылка на сообщение или пересылка из канала.`,
      };
    }
    if (!isTypedText(raw)) return { kind: "other", text: hiddenSourceRefusal };
    const text = (raw as { text: string }).text;
    return {
      kind: "text",
      text: LinkInPhrasePattern.test(text)
        ? linkInPhraseRefusal
        : typedTextRefusal,
    };
  }
  const kind = [
    `forward:${forward}`,
    ...(media === undefined ? [] : [media[0]]),
  ].join(",");
  // Скрытый источник тоже называет вид: «нельзя дать ссылку» на видео
  // оставило бы человека пробовать то же видео из другого источника.
  if (forward !== "user" && forward !== "chat") {
    return {
      kind,
      text:
        media === undefined
          ? hiddenSourceRefusal
          : `${media[1]} не принимается материалом. ${hiddenSourceRefusal}`,
    };
  }
  return {
    kind,
    text:
      media === undefined
        ? `Сообщение из чата: ${linkHint}`
        : `${media[1]} не принимается материалом, а ${linkHint}`,
  };
}

// Пересылку из чата бот не принимает (PER-762), поэтому отказ тексту зовёт
// ссылкой, а не пересылкой из чата, и называет её форму (PER-793).
const typedTextRefusal =
  "Текст сам по себе не материал: пришли ссылку на сообщение вида https://t.me/…, перешли сообщение из канала, фото или документ.";
const linkInPhraseRefusal =
  "Ссылку на сообщение пришли отдельно, без другого текста: https://t.me/…";
const hiddenSourceRefusal =
  "На это сообщение нельзя дать ссылку. Источник скрыт или пересылка из него запрещена: нужно пересланное сообщение с доступным источником, фотография или документ.";
const linkHint =
  "из пересылки ссылку не собрать, скопируй ссылку на сообщение («Копировать ссылку») и пришли её.";

export function parseMaterialInput(
  raw: unknown,
): PendingMaterialSource | undefined {
  const link = parseMessageLink(raw);
  if (link !== undefined) return { kind: "message-link", url: link };
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

/**
 * То же подтверждение в HTML: вопрос — жирным заголовком. Видимый текст
 * совпадает с `materialConfirmationText`, и разбор читает его тем же путём:
 * Telegram возвращает текст без разметки.
 */
export function materialConfirmationHtml(
  title: string,
  escapeHtml: (value: string) => string,
): string {
  return `<b>${confirmationQuestion}</b>\n\nНазвание: ${escapeHtml(title)}`;
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
    return {
      title,
      source: { kind: "file", fileId: document.file_id, fileKind: "document" },
    };
  }
  const photo = parsed.data.photo?.at(-1);
  if (photo !== undefined) {
    return {
      title,
      source: { kind: "file", fileId: photo.file_id, fileKind: "photo" },
    };
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
