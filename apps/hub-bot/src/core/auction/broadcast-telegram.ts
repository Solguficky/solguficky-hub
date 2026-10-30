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

const stopKeyboard = () =>
  new InlineKeyboard().text(watchStopLabel, BROADCAST_STOP_DATA);

type BroadcastTelegram = Pick<Api, "sendMessage" | "editMessageText">;

export function createBroadcastApi(options: {
  api: BroadcastTelegram;
  // Метка каталога экранов поверхности: ложится в параметры вызова.
  mark: object;
  report: (error: string) => void;
}): BroadcastApi {
  const { api, mark } = options;
  return {
    async send({ chatId, text }) {
      try {
        // Звук один раз, на первом сообщении: правки сообщения беззвучны.
        const sent = await api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: stopKeyboard(),
          ...mark,
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
