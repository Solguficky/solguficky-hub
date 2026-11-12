import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createMediaChat, type MediaChatApi } from "./media-chat.js";

// Чат медиа ботов (PER-776): публикация копией из чата человека, показ копией
// поста и отказы Telegram, которые медиа снимают, а не роняют сообщение.

const channelId = -1001234567890;

function refusal(code: number, description: string): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: code, description },
    "copyMessage",
    {},
  );
}

function api(fails?: unknown): MediaChatApi & {
  copyMessage: ReturnType<typeof vi.fn>;
} {
  return {
    copyMessage: vi.fn(async () => {
      if (fails !== undefined) throw fails;
      return { message_id: 77 };
    }),
  };
}

describe("createMediaChat", () => {
  it("is off without a channel and publishes nothing", async () => {
    const warn = vi.fn();
    const media = createMediaChat({ channelId: undefined, logger: { warn } });
    const telegram = api();

    expect(media.enabled).toBe(false);
    expect(await media.publish(telegram, 5, 10)).toEqual({
      kind: "unavailable",
      reason: "media chat is off",
    });
    expect(telegram.copyMessage).not.toHaveBeenCalled();
  });

  it("publishes the message of the person as a post of the channel", async () => {
    const telegram = api();
    const media = createMediaChat({ channelId, logger: { warn: vi.fn() } });

    expect(media.enabled).toBe(true);
    expect(await media.publish(telegram, 5, 10)).toEqual({
      kind: "published",
      postId: 77,
    });
    expect(telegram.copyMessage).toHaveBeenCalledWith(channelId, 5, 10);
  });

  it("records a channel the bot cannot post to as unavailable", async () => {
    const warn = vi.fn();
    const media = createMediaChat({ channelId, logger: { warn } });

    expect(
      await media.publish(
        api(refusal(403, "Forbidden: bot is not a member of the channel chat")),
        5,
        10,
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "Forbidden: bot is not a member of the channel chat",
    });
    expect(warn).toHaveBeenCalledWith("media chat post not published", {
      error_category: "dependency_unavailable",
      error: "Forbidden: bot is not a member of the channel chat",
    });
  });

  it("shows the post with its own caption and keyboard", async () => {
    const telegram = api();
    const media = createMediaChat({ channelId, logger: { warn: vi.fn() } });
    const markup = { inline_keyboard: [] };

    expect(
      await media.show(telegram, 9, 42, {
        caption: "Текст",
        markup,
        mark: { tag: "x" },
      }),
    ).toEqual({ kind: "shown", messageId: 77 });
    expect(telegram.copyMessage).toHaveBeenCalledWith(9, channelId, 42, {
      tag: "x",
      caption: "Текст",
      reply_markup: markup,
    });
  });

  it("throws what is about the recipient or the network, not the post", async () => {
    const media = createMediaChat({ channelId, logger: { warn: vi.fn() } });

    await expect(
      media.show(
        api(refusal(403, "Forbidden: bot was blocked by the user")),
        9,
        42,
        {
          caption: "Текст",
        },
      ),
    ).rejects.toBeInstanceOf(GrammyError);
    await expect(
      media.show(api(refusal(429, "Too Many Requests")), 9, 42, {
        caption: "Текст",
      }),
    ).rejects.toBeInstanceOf(GrammyError);
    await expect(
      media.show(api(new Error("network")), 9, 42, { caption: "Текст" }),
    ).rejects.toThrow("network");
  });
});
