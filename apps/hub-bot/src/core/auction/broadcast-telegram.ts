import { type Api, GrammyError, InlineKeyboard } from "grammy";
import { watchStopLabel } from "../../auction-broadcast.js";
import type { BroadcastApi } from "./broadcast.js";
import { type LiveEditOutcome, liveEditFailure } from "./live-cards.js";

// Сторона Telegram у трансляции хода торгов (PER-826): первое сообщение и
// правки. Общая у обоих ботов; метка каталога экранов своя у каждой
// поверхности и приходит параметром, потому что каталоги поверхностей
// друг друга не знают.

/** Данные кнопки «Не следить» под сообщением трансляции. */
export const BROADCAST_STOP_DATA = "v1:bc:x";

// Дольше этой паузы первое сообщение не ждёт: человек уже смотрит карточку.
const MAX_SEND_PAUSE_S = 10;

const stopKeyboard = () =>
  new InlineKeyboard().text(watchStopLabel, BROADCAST_STOP_DATA);

type BroadcastTelegram = Pick<Api, "sendMessage" | "editMessageText">;

export function createBroadcastApi(options: {
  api: BroadcastTelegram;
  // Метка каталога экранов поверхности: ложится в параметры вызова.
  mark: object;
  report: (error: string) => void;
  // Пауза перед повтором отправки после `429`; тест подменяет.
  sleep?: (ms: number) => Promise<void>;
}): BroadcastApi {
  const { api, mark } = options;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Первое сообщение идёт мимо лимитера правок, поэтому `429` на нём
  // переживает одна повторная отправка: на старте финала нажимают разом.
  const sendOnce = (chatId: number, text: string) =>
    api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: stopKeyboard(),
      ...mark,
    });
  return {
    async send({ chatId, text }) {
      try {
        // Звук один раз, на первом сообщении: правки сообщения беззвучны.
        const sent = await sendOnce(chatId, text).catch(async (cause) => {
          if (!(cause instanceof GrammyError) || cause.error_code !== 429) {
            throw cause;
          }
          await sleep(
            Math.min(cause.parameters.retry_after ?? 1, MAX_SEND_PAUSE_S) *
              1_000,
          );
          return sendOnce(chatId, text);
        });
        return sent.message_id;
      } catch (cause) {
        if (!(cause instanceof GrammyError)) options.report(String(cause));
        else if (cause.error_code !== 403) options.report(cause.description);
        return undefined;
      }
    },
    async edit(target, { text, final }): Promise<LiveEditOutcome> {
      try {
        await api.editMessageText(target.chatId, target.messageId, text, {
          parse_mode: "HTML",
          reply_markup: final ? { inline_keyboard: [] } : stopKeyboard(),
          ...mark,
        });
        return { kind: "done" };
      } catch (cause) {
        return liveEditFailure(cause, options.report);
      }
    },
  };
}
