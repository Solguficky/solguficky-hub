import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  BROADCAST_STOP_DATA,
  createBroadcastApi,
} from "./broadcast-telegram.js";

const rateLimited = () =>
  new GrammyError(
    "Too Many Requests",
    {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 3",
      parameters: { retry_after: 3 },
    },
    "sendMessage",
    {},
  );

function setup(sendMessage: ReturnType<typeof vi.fn>) {
  const sleeps: number[] = [];
  const report = vi.fn();
  const api = createBroadcastApi({
    api: { sendMessage, editMessageText: vi.fn() } as never,
    mark: {},
    report,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, sleeps, report };
}

describe("broadcast telegram adapter", () => {
  it("sends the first message with the stop button", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 55 }));
    const { api } = setup(sendMessage);

    await expect(api.send({ chatId: 7, text: "t" })).resolves.toBe(55);
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      "t",
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [{ text: "Не следить", callback_data: BROADCAST_STOP_DATA }],
          ],
        }),
      }),
    );
  });

  it("waits the named pause once and sends again after a 429", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ message_id: 56 });
    const { api, sleeps } = setup(sendMessage);

    await expect(api.send({ chatId: 7, text: "t" })).resolves.toBe(56);
    expect(sleeps).toEqual([3_000]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second 429 without losing the process", async () => {
    const sendMessage = vi.fn().mockRejectedValue(rateLimited());
    const { api, report } = setup(sendMessage);

    await expect(api.send({ chatId: 7, text: "t" })).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
