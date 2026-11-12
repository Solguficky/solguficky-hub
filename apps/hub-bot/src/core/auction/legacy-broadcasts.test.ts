import { describe, expect, it, vi } from "vitest";
import {
  broadcastMovedLine,
  closeLegacyBroadcasts,
  createLegacyBroadcastCloser,
} from "./legacy-broadcasts.js";

describe("messages of the old broadcast", () => {
  it("edits each message once, without a button, and drops its record", async () => {
    const editMessageText = vi.fn(async () => true);
    const removed: number[] = [];
    const closed = await closeLegacyBroadcasts({
      store: {
        list: async () => [
          { chatId: 1, messageId: 10 },
          { chatId: 2, messageId: 20 },
        ],
        remove: async (chatId) => {
          removed.push(chatId);
        },
      },
      closer: createLegacyBroadcastCloser({
        api: { editMessageText } as never,
        mark: {},
        report: () => {},
      }),
    });

    expect(closed).toBe(2);
    expect(editMessageText).toHaveBeenCalledWith(
      1,
      10,
      broadcastMovedLine,
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
    );
    expect(removed).toEqual([1, 2]);
  });

  it("drops the record even when the message is gone", async () => {
    const removed: number[] = [];
    await closeLegacyBroadcasts({
      store: {
        list: async () => [{ chatId: 1, messageId: 10 }],
        remove: async (chatId) => {
          removed.push(chatId);
        },
      },
      closer: createLegacyBroadcastCloser({
        api: {
          editMessageText: async () => {
            throw new Error("boom");
          },
        } as never,
        mark: {},
        report: () => {},
      }),
    });

    expect(removed).toEqual([1]);
  });
});
