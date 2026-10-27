import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionPort,
  FavoritesPort,
  LotSetView,
  LotView,
  Viewer,
} from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import { showLot } from "./open-lot.js";
import { feedItemOf } from "./standing.js";

// Экран сета (ADR-073, п. 7): лоты сета по порядку организатора, а после
// итога — собравший его по отображаемому имени.
//
// Сет читается из снимка лота, с которого открыли экран: Auction отдаёт его
// вместе с остальным снимком, а отдельного чтения сета в контракте нет.
// Состав сета — оттуда же: список лотов сета по порядку организатора.
//
// Лот вне сета — сет удалили или лот из него убрали, пока экран висел. Тогда
// показывается карточка лота: она и была поводом открыть этот экран.

// Сколько лотов сета показывает экран: предел страницы (дизайн-код,
// «Клавиатура»). Сет по решению владельца — два-четыре лота (ADR-073,
// «Предсказание»), а предел держит экран в телефоне.
export const SET_PAGE_SIZE = 8;

export async function openSet(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  lotId: string;
  page: number;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
  });
  const lotSet = lot.lotSet;
  // Сет из меньше чем двух лотов неполный, и участнику он не показывается
  // (ADR-073, п. 3).
  if (lotSet === undefined || lotSet.lotIds.length < 2) {
    return showLot({
      auction: input.auction,
      ...(input.favorites === undefined ? {} : { favorites: input.favorites }),
      viewer: input.viewer,
      lot,
      page: input.page,
    });
  }
  const lots = await readSetLots({
    auction: input.auction,
    viewer: input.viewer,
    current: lot,
    set: lotSet,
  });
  const shown = lots.slice(0, SET_PAGE_SIZE);
  const more = lots.length - shown.length;
  return {
    blocks: [
      {
        kind: "set",
        auctionId: lot.auctionId,
        name: lotSet.name,
        lots: shown.map((item) => feedItemOf(item, input.viewer)),
        // Лоты сета, которых экран не показал.
        ...(more === 0 ? {} : { more }),
        ...(lotSet.collectorName === undefined
          ? {}
          : { collectorName: lotSet.collectorName }),
      },
    ],
    keyboard: [
      // Лоты сета — содержимое списка, по одному в ряду (дизайн-код,
      // «Клавиатура»). Кнопка ведёт карточку лота и несёт страницу ленты, с
      // которой открыли сет: «‹ Лоты» с неё возвращает туда же.
      ...shown.map((item) => [
        {
          action: "set.open-lot" as const,
          lotId: item.lotId,
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: item.lotId,
            page: input.page,
          }),
        },
      ]),
      // Возврат — карточка лота, с которой открыли сет.
      [
        {
          action: "set.back" as const,
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page: input.page,
          }),
        },
      ],
    ],
  };
}

// Лоты сета по порядку организатора. Текущий лот уже прочитан; остальные
// читаются по одному, а лот, которого Auction больше не знает или не
// показывает, выпадает: сет из таких лотов участнику не показывается.
// Отказ чтения лота не выпадает, а роняет экран: показать состав неполным
// без признака сбоя хуже, чем сказать «недоступно».
async function readSetLots(input: {
  auction: AuctionPort;
  viewer: Viewer;
  current: LotView;
  set: LotSetView;
}): Promise<LotView[]> {
  const others = await Promise.all(
    input.set.lotIds.map((lotId) =>
      lotId === input.current.lotId
        ? undefined
        : input.auction.findLot({ viewer: input.viewer, lotId }),
    ),
  );
  const byId = new Map<string, LotView>([[input.current.lotId, input.current]]);
  others.forEach((lot, index) => {
    const lotId = input.set.lotIds[index];
    if (lot !== undefined && lotId !== undefined) byId.set(lotId, lot);
  });
  return input.set.lotIds
    .map((lotId) => byId.get(lotId))
    .filter((lot): lot is LotView => lot !== undefined);
}
