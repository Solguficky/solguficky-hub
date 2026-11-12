import type { Api } from "grammy";
import type { LegacyBroadcastStore } from "./legacy-broadcasts-kv.js";
import { liveEditFailure } from "./live-cards.js";

// Сообщения трансляции хода торгов прежней выкладки (PER-826): слежение теперь
// живёт в самой карточке лота (PER-837), и у такого сообщения нечем ходить в
// поток. Бот правит его один раз — говорит, куда переехало слежение, и снимает
// кнопку, — и не открывает заново. Общее у обоих ботов; метка каталога
// экранов своя у каждой поверхности и приходит параметром.

/** Данные кнопки «Не следить» под сообщением прежней трансляции. */
export const LEGACY_BROADCAST_STOP_DATA = "v1:bc:x";

export const broadcastMovedLine =
  "Трансляция перенесена на карточку лота: нажми «Следить за торгами» на ней.";

export type LegacyBroadcastCloser = {
  /** Правка без звука и без кнопки; сообщения, которого нет, не бросает. */
  close(target: { chatId: number; messageId: number }): Promise<void>;
};

export function createLegacyBroadcastCloser(options: {
  api: Pick<Api, "editMessageText">;
  mark: object;
  report: (error: string) => void;
}): LegacyBroadcastCloser {
  return {
    async close({ chatId, messageId }) {
      try {
        await options.api.editMessageText(
          chatId,
          messageId,
          broadcastMovedLine,
          {
            reply_markup: { inline_keyboard: [] },
            ...options.mark,
          },
        );
      } catch (cause) {
        // `429` и обрыв здесь не повторяются: сообщение — остаток прежней
        // выкладки, а кнопка под ним закроет его при нажатии.
        liveEditFailure(cause, options.report);
      }
    },
  };
}

/**
 * Старт процесса: записи прежней выкладки читаются один раз, их сообщения
 * закрываются, записи снимаются. Возвращает число закрытых сообщений.
 */
export async function closeLegacyBroadcasts(options: {
  store: LegacyBroadcastStore;
  closer: LegacyBroadcastCloser;
}): Promise<number> {
  const records = await options.store.list();
  for (const record of records) {
    await options.closer.close(record);
    await options.store.remove(record.chatId);
  }
  return records.length;
}
