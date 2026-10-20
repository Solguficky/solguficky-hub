import type { LiveEditOutcome } from "../../../core/auction/live-cards.js";
import type { AuctionWatches } from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import {
  createLiveScreens,
  type LiveScreenEntry,
  type LiveScreenRead,
  type LiveScreens,
} from "./live-screens.js";
import {
  type FloorScreenView,
  floorScreen,
  liveFloor,
} from "./screens/floor-bids.js";
import type { ShownScreen } from "./screens/show.js";

// Открытые «Ставки зала» помощника (PER-565) — живой экран общего механизма
// `live-screens.ts`, как пульт ведущего: экран показывает имена аукциона и
// лидера, которых в потоке нет, поэтому состояние потока — повод перечитать
// его тем же чтением, что «Обновить». Страница людей — та, что видит помощник.

export type LiveFloorEntry = LiveScreenEntry<FloorScreenView>;
export type LiveFloors = LiveScreens<FloorScreenView>;

// Экран открывает помощник, их на аукцион один-два.
export const LIVE_FLOORS_LIMIT = 200;

export function createLiveFloors(options: {
  watches: AuctionWatches;
  limiter: EditLimiter;
  read: (entry: LiveFloorEntry) => Promise<LiveScreenRead<FloorScreenView>>;
  edit: (
    entry: LiveFloorEntry,
    screen: ShownScreen,
  ) => Promise<LiveEditOutcome>;
  limit?: number;
}): LiveFloors {
  return createLiveScreens<FloorScreenView>(
    {
      key: "floor",
      live: liveFloor,
      auctionOf: (view) => view.floor.auctionId,
      versions: (view) => new Map(Object.entries(view.floor.versions)),
      active: (view) => view.floor.lot?.lotId,
      render: (view, stale) =>
        floorScreen(stale ? { ...view, stale: true } : view),
    },
    {
      watches: options.watches,
      limiter: options.limiter,
      read: options.read,
      edit: options.edit,
      limit: options.limit ?? LIVE_FLOORS_LIMIT,
    },
  );
}
