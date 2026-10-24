import { z } from "zod";

// Ответ на вопрос о фото лота (PER-452). Принимается только фотография: Telegram
// уже сжал её при приёме, и в Auction уходит наибольший размер (ADR-057,
// дополнение 2026-09-30). Документ, даже с картинкой, и стикер фотографией не
// считаются. Альбом приходит сообщением на каждый снимок, и каждый снимок —
// своё фото лота (PER-721): `group` связывает их, чтобы исход был один на
// альбом.

const LotPhotoSchema = z.object({
  photo: z
    .array(z.object({ file_id: z.string().min(1) }))
    .min(1)
    .optional(),
  media_group_id: z.string().optional(),
});

export type LotPhotoInput =
  | { kind: "photo"; fileId: string; group?: string }
  | { kind: "not-photo" };

export function parseLotPhoto(raw: unknown): LotPhotoInput {
  const parsed = LotPhotoSchema.safeParse(raw);
  if (!parsed.success) return { kind: "not-photo" };
  const largest = parsed.data.photo?.at(-1);
  if (largest === undefined) return { kind: "not-photo" };
  const group = parsed.data.media_group_id;
  return {
    kind: "photo",
    fileId: largest.file_id,
    ...(group === undefined ? {} : { group }),
  };
}
