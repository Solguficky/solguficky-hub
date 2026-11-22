import { describe, expect, it } from "vitest";
import type { MeetupMaterial } from "../meetups/port.js";
import {
  materialPhoto,
  materialPhotoId,
  nextPhotoNumber,
} from "./material-photo.js";

describe("material photos", () => {
  it("uses the largest Telegram photo and its stable identifier", () => {
    expect(
      materialPhoto({
        photo: [
          { file_id: "small", file_unique_id: "small-unique" },
          { file_id: "large", file_unique_id: "large-unique" },
        ],
      }),
    ).toEqual({ fileId: "large", uniqueId: "large-unique" });
    expect(
      materialPhoto({ photo: [{ file_id: "missing-unique" }] }),
    ).toBeUndefined();
  });

  it("derives the same id for a repeat in one meetup only", () => {
    expect(materialPhotoId("meetup", "photo")).toBe(
      materialPhotoId("meetup", "photo"),
    );
    expect(materialPhotoId("meetup", "photo")).not.toBe(
      materialPhotoId("other", "photo"),
    );
    expect(materialPhotoId("meetup", "photo")).not.toBe(
      materialPhotoId("meetup", "other"),
    );
  });

  it("continues after the largest existing automatic photo name", () => {
    const materials: MeetupMaterial[] = [
      {
        id: "a",
        title: "Афиша",
        source: { kind: "file", fileId: "a", fileKind: "photo" },
      },
      {
        id: "b",
        title: "Фото 3",
        source: { kind: "file", fileId: "b", fileKind: "photo" },
      },
      {
        id: "c",
        title: "Фото 99",
        source: { kind: "file", fileId: "c", fileKind: "document" },
      },
    ];
    expect(nextPhotoNumber([])).toBe(1);
    expect(nextPhotoNumber(materials)).toBe(4);
  });
});
