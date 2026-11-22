import { z } from "zod";
import { uuidV7Of } from "../../../core/uuid-v7.js";
import type { MeetupMaterial } from "../meetups/port.js";

const PhotoInput = z.object({
  photo: z
    .array(
      z.object({
        file_id: z.string().min(1),
        file_unique_id: z.string().min(1),
      }),
    )
    .min(1),
});

export function materialPhoto(
  raw: unknown,
): { fileId: string; uniqueId: string } | undefined {
  const parsed = PhotoInput.safeParse(raw);
  if (!parsed.success) return undefined;
  const photo = parsed.data.photo.at(-1);
  return photo === undefined
    ? undefined
    : { fileId: photo.file_id, uniqueId: photo.file_unique_id };
}

// Одна и та же фотография в одной сходке остаётся той же командой при повторе.
export function materialPhotoId(meetupId: string, uniqueId: string): string {
  return uuidV7Of(
    JSON.stringify(["meetup-material-photo", meetupId, uniqueId]),
    0,
  );
}

export function nextPhotoNumber(materials: readonly MeetupMaterial[]): number {
  return (
    materials.reduce((maximum, material) => {
      if (
        material.source.kind !== "file" ||
        material.source.fileKind !== "photo"
      )
        return maximum;
      const match = /^Фото ([1-9]\d*)$/.exec(material.title);
      const number = match === null ? 0 : Number(match[1]);
      return Number.isSafeInteger(number) ? Math.max(maximum, number) : maximum;
    }, 0) + 1
  );
}
