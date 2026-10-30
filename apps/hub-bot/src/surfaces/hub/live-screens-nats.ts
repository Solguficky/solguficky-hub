import {
  createLegacyBroadcastStore,
  type LegacyBroadcastStore,
} from "../../core/auction/legacy-broadcasts-kv.js";
import type { WatchStore } from "../../core/auction/live-cards.js";
import { reportLiveStoreFailure } from "../../core/auction/live-failures.js";
import { createLiveKvLink } from "../../core/auction/live-kv-link.js";
import { createWatchStore } from "../../core/auction/watch-kv.js";
import type { Logger } from "../../core/logging.js";
import type { LiveScreenStore } from "./presentation/live-screens.js";
import { createLiveScreenKvStore } from "./presentation/live-screens-kv.js";

// Хранилище открытых живых экранов хаба (PER-815): соединение с bucket'ом
// общее с трансляцией хода торгов (`core/auction/live-kv-link.ts`), здесь —
// записи пульта и «Ставок зала». Отказ шины значит «экраны живут как раньше».
export type LiveScreensNats = {
  screens(kind: "console" | "floor"): LiveScreenStore;
  // Карточки лота в слежении (PER-837) делят с пультом соединение и bucket.
  watches(): WatchStore;
  // Записи трансляции прежней выкладки (PER-826): читаются один раз и снимаются.
  legacyBroadcasts(): LegacyBroadcastStore;
  close(): Promise<void>;
};

export function createLiveScreensNats(options: {
  url: string;
  service: string;
  logger: Logger;
}): LiveScreensNats {
  const { logger } = options;
  const link = createLiveKvLink(options);

  const store = (kind: "console" | "floor"): LiveScreenStore => {
    const lazy = async <T>(
      use: (store: LiveScreenStore) => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      const bound = await link.kv();
      if (bound === undefined) return fallback;
      return use(
        createLiveScreenKvStore({
          kv: bound,
          kind,
          onError: (operation, cause) =>
            reportLiveStoreFailure(logger, operation, cause),
        }),
      );
    };
    return {
      save: (target) => lazy((each) => each.save(target), undefined),
      remove: (chatId) => lazy((each) => each.remove(chatId), undefined),
      list: () => lazy((each) => each.list(), []),
    };
  };

  return {
    screens: store,
    watches: () => createWatchStore(link, logger),
    legacyBroadcasts: () => createLegacyBroadcastStore(link, logger),
    close: () => link.close(),
  };
}
