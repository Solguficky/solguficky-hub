import { z } from "zod";
import { checkBroadcastBody } from "../application/broadcasts.js";

// Кадр подтверждения рассылки — ответ бота на его же сообщение предпросмотра,
// и текст рассылки читается оттуда, а не из памяти процесса: так подтверждение
// переживает рестарт, как подтверждение материала. Предпросмотр принимается
// только от самого бота — ответ на чужое сообщение текстом рассылки не станет.
const ConfirmationSchema = z.object({
  reply_to_message: z.object({
    from: z.object({ id: z.number().int() }),
    text: z.string(),
  }),
});

export function parseBroadcastPreview(
  raw: unknown,
  botId: number,
): string | undefined {
  const parsed = ConfirmationSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const preview = parsed.data.reply_to_message;
  if (preview.from.id !== botId) return undefined;
  const checked = checkBroadcastBody(preview.text);
  return checked.kind === "ok" ? checked.body : undefined;
}
