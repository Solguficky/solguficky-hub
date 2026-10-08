import { z } from "zod";

// Ответ на вопрос о фото лота (PER-452). Принимается только фотография: Telegram
// уже сжал её при приёме, и в Auction уходит наибольший размер (ADR-057,
// дополнение 2026-09-30). Документ, даже с картинкой, и стикер фотографией не
// считаются, а альбом лоту не подходит: фото у лота одно.

const LotPhotoSchema = z.object({
  photo: z
    .array(z.object({ file_id: z.string().min(1) }))
    .min(1)
    .optional(),
  media_group_id: z.string().optional(),
});

export type LotPhotoInput =
  | { kind: "photo"; fileId: string }
  | { kind: "album"; group: string }
  | { kind: "not-photo" };

export function parseLotPhoto(raw: unknown): LotPhotoInput {
  const parsed = LotPhotoSchema.safeParse(raw);
  if (!parsed.success) return { kind: "not-photo" };
  if (parsed.data.media_group_id !== undefined) {
    return { kind: "album", group: parsed.data.media_group_id };
  }
  const largest = parsed.data.photo?.at(-1);
  return largest === undefined
    ? { kind: "not-photo" }
    : { kind: "photo", fileId: largest.file_id };
}
