import type { LiveEditOutcome } from "../../../core/auction/live-cards.js";
import type { AuctionWatches } from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import {
  createLiveScreens,
  type LiveScreenEntry,
  type LiveScreenShown,
  type LiveScreenStore,
  type LiveScreens,
  type LiveScreenTarget,
} from "./live-screens.js";
import {
  type ConsoleScreenView,
  consoleScreen,
  liveConsole,
} from "./screens/auction-console.js";
import type { ShownScreen } from "./screens/show.js";

// Открытые пульты ведущего (PER-566) — память процесса, то же исключение из
// «хранилища нет» ADR-030, что карточки финала (дополнение 2026-10-19). Пульт
// показывает имя лидера, последние ставки и состав, а поток несёт только
// снимки лотов, поэтому пульт — живой экран общего механизма
// `live-screens.ts` (PER-565): состояние потока — повод перечитать его тем же
// чтением, что «Обновить».

/** Пульт в показанном сообщении: кто его открыл и что он показывает. */
export type LiveConsoleShown = LiveScreenShown<ConsoleScreenView>;

/** Открытый пульт: где он и с чем его открыли. */
export type LiveConsoleEntry = LiveScreenEntry<ConsoleScreenView>;

/**
 * Чтение пульта вне update. `refused` — пульт больше не открыть: права сняли
 * или аукциона нет; `failed` — Auction не ответил, и экран получает пометку.
 */
export type LiveConsoleRead =
  | { kind: "console"; view: ConsoleScreenView }
  | { kind: "refused" }
  | { kind: "failed" };

export type LiveConsoles = LiveScreens<ConsoleScreenView>;

// Пульт открывает ведущий, их на аукцион один-два; предел держит память,
// если пульты открывают чаще, чем закрывают.
export const LIVE_CONSOLES_LIMIT = 200;

export function createLiveConsoles(options: {
  watches: AuctionWatches;
  limiter: EditLimiter;
  read: (target: LiveScreenTarget) => Promise<LiveConsoleRead>;
  edit: (
    entry: LiveConsoleEntry,
    screen: ShownScreen,
  ) => Promise<LiveEditOutcome>;
  limit?: number;
  store?: LiveScreenStore;
  restorePauses?: readonly number[];
}): LiveConsoles {
  return createLiveScreens<ConsoleScreenView>(
    {
      key: "console",
      live: liveConsole,
      auctionOf: (view) => view.console.auctionId,
      params: (view) => ({
        page: view.page,
        sort: view.sort,
        ...(view.media === true ? { media: true } : {}),
      }),
      versions: (view) =>
        new Map(
          view.console.lots.map((each) => [each.lot.lotId, each.lot.version]),
        ),
      active: (view) => view.console.lineup?.activeLotId,
      render: (view, stale) =>
        consoleScreen(stale ? { ...view, stale: true } : view),
    },
    {
      watches: options.watches,
      limiter: options.limiter,
      read: async (entry) => {
        const read = await options.read(entry);
        return read.kind === "console"
          ? { kind: "view", view: read.view }
          : read;
      },
      edit: options.edit,
      limit: options.limit ?? LIVE_CONSOLES_LIMIT,
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.restorePauses === undefined
        ? {}
        : { restorePauses: options.restorePauses }),
    },
  );
}
