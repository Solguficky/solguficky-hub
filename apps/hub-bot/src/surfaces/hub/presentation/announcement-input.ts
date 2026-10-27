import { z } from "zod";
import { checkAnnouncementText } from "../../../core/notifications/organizer-announcement.js";
import { fingerprint } from "../application/fingerprint.js";
import { announcementTextLead } from "./screens/auction-announcement.js";

// Объявление аукциона (PER-765): текст живёт в сообщениях самого бота, а не в
// памяти процесса, — так шаги переживают рестарт, как подтверждение смены
// приза, а текст до 1024 знаков в 64 байта кнопки не помещается. Кнопка несёт
// отпечаток текста: текст, который с ним не сходится, объявлением не станет.

const StepSchema = z.object({
  from: z.object({ id: z.number().int() }),
  text: z.string(),
});

/** Текст из кадра шага: всё после строки `announcementTextLead`. */
export function parseStepText(
  raw: unknown,
  botId: number,
  print: string,
): string | undefined {
  const parsed = StepSchema.safeParse(raw);
  if (!parsed.success || parsed.data.from.id !== botId) return undefined;
  const lead = `\n${announcementTextLead}\n`;
  const at = parsed.data.text.indexOf(lead);
  if (at === -1) return undefined;
  return accepted(parsed.data.text.slice(at + lead.length), print);
}

// Предпросмотр — сообщение, каким его получат: текст простым сообщением или
// подписью фото.
const PreviewSchema = z.object({
  reply_to_message: z.object({
    message_id: z.number().int(),
    date: z.number().int(),
    from: z.object({ id: z.number().int() }),
    text: z.string().optional(),
    caption: z.string().optional(),
  }),
});

export type AnnouncementPreview = {
  text: string;
  messageId: number;
  // Момент предпросмотра в миллисекундах: из него и номера сообщения
  // рождается ключ объявления.
  sentAt: number;
};

/** Текст из предпросмотра, на который отвечает кадр «Отправить». */
export function parsePreviewText(
  raw: unknown,
  botId: number,
  print: string,
): AnnouncementPreview | undefined {
  const parsed = PreviewSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const preview = parsed.data.reply_to_message;
  if (preview.from.id !== botId) return undefined;
  const text = accepted(preview.text ?? preview.caption ?? "", print);
  return text === undefined
    ? undefined
    : {
        text,
        messageId: preview.message_id,
        sentAt: preview.date * 1000,
      };
}

function accepted(raw: string, print: string): string | undefined {
  const checked = checkAnnouncementText(raw);
  return checked.kind === "ok" && fingerprint(checked.text) === print
    ? checked.text
    : undefined;
}

// Своё медиа объявления (PER-776) — одно фото или одно видео ответом на
// вопрос. Документ с картинкой, стикер и анимация медиа объявления не
// считаются: копия поста ушла бы получателю файлом.
const MediaSchema = z.union([
  z.object({ photo: z.array(z.object({ file_id: z.string() })).min(1) }),
  z.object({ video: z.object({ file_id: z.string() }) }),
]);

/** Ответ — фото или видео, которое можно опубликовать в чат медиа. */
export function parseAnnouncementMedia(raw: unknown): boolean {
  return MediaSchema.safeParse(raw).success;
}
