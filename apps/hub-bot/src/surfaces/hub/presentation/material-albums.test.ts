import { afterEach, describe, expect, it, vi } from "vitest";
import { createMaterialAlbums } from "./material-albums.js";

afterEach(() => vi.useRealTimers());

describe("material album drafts", () => {
  it("waits for in-flight updates and invalidates a draft on a late update", async () => {
    vi.useFakeTimers();
    const albums = createMaterialAlbums();
    const ready = vi.fn(async () => {});
    const first = { fileId: "one", uniqueId: "one", messageId: 1 };
    const second = { fileId: "two", uniqueId: "two", messageId: 2 };
    expect(albums.begin("group")).toBe("accepted");
    expect(albums.finish("group", first, ready)).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(albums.begin("group")).toBe("accepted");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ready).not.toHaveBeenCalled();
    expect(albums.finish("group", second, ready)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ready).toHaveBeenCalledWith([first, second]);
    expect(
      albums.put("group", "token", {
        meetupId: "m",
        version: 1,
        telegramUserId: 1,
        photos: [first, second],
      }),
    ).toBe(true);
    expect(albums.begin("group")).toBe("late");
    expect(albums.take("token", "m", 1)).toBeUndefined();
  });

  it("does not confirm any part of a failed album", async () => {
    vi.useFakeTimers();
    const albums = createMaterialAlbums();
    const ready = vi.fn(async () => {});
    albums.begin("group");
    albums.finish(
      "group",
      { fileId: "one", uniqueId: "one", messageId: 1 },
      ready,
    );
    albums.begin("group");
    albums.fail("group");
    expect(albums.begin("group")).toBe("ignored");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ready).not.toHaveBeenCalled();
  });

  it("cancels only the selected confirmation", async () => {
    vi.useFakeTimers();
    const albums = createMaterialAlbums();
    const photo = { fileId: "one", uniqueId: "one", messageId: 1 };
    const album = {
      meetupId: "m",
      version: 1,
      telegramUserId: 1,
      photos: [photo],
    };
    for (const key of ["a", "b"]) {
      albums.begin(key);
      albums.finish(key, photo, async () => {});
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(albums.put("a", "first", album)).toBe(true);
    expect(albums.put("b", "second", album)).toBe(true);
    albums.discard("first", "m", 1);
    expect(albums.take("first", "m", 1)).toBeUndefined();
    expect(albums.take("second", "m", 1)).toEqual(album);
    expect(albums.begin("b")).toBe("late-confirmed");
  });
});
