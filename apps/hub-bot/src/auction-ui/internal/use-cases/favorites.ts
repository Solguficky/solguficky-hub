import { encodeAuctionCallback, MAX_FEED_PAGE } from "../../callback-data.js";
import type {
  AuctionPort,
  FavoritesPort,
  LotView,
  Viewer,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { FEED_PAGE_SIZE } from "./open-feed.js";
import { showLot } from "./open-lot.js";
import { feedItemOf, mineOf, withMine } from "./standing.js";

// Сырые юзкейсы избранного (PER-495, ADR-063): доступ проверил шлюз. Отметки
// хранит Notifications, а цену, дедлайн и итог каждого лота экран читает у
// Auction, как карточка.

// Отметка или снятие с карточки. Лот читается до команды: отметку ставит
// только тот, кому Auction лот показывает, — поддельная кнопка на невидимый
// лот падает до Notifications. Ответ команды — состояние после неё, и
// карточка показывает его, не перечитывая список: повторное нажатие той же
// кнопки отвечает тем же состоянием, а не второй отметкой.
export async function toggleFollow(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  lotId: string;
  page: number;
  follow: boolean;
}): Promise<AuctionScreenBody> {
  const { favorites, viewer, lotId, page } = input;
  const lot = await input.auction.getLot({ viewer, lotId });
  // Адреса Notifications у процесса нет — кнопка пришла со старого экрана.
  // Карточка без кнопки и есть актуальная перерисовка.
  if (favorites === undefined) return showLot({ ...input, lot });
  const outcome = input.follow
    ? await favorites.followLot({ viewer, lotId })
    : await favorites.unfollowLot({ viewer, lotId });
  if (outcome.kind === "not-ready") {
    return {
      blocks: [
        {
          kind: "follow-refused",
          lotId,
          auctionId: lot.auctionId,
          ...(lot.card === undefined ? {} : { title: lot.card.title }),
        },
      ],
      keyboard: [
        [
          {
            action: "result.lot",
            callbackData: encodeAuctionCallback({ kind: "lot", lotId, page }),
          },
        ],
      ],
    };
  }
  return showLot({ ...input, lot, following: outcome.following });
}

const MAX_FAVORITES = FEED_PAGE_SIZE * (MAX_FEED_PAGE + 1);

// Список своих отметок по порядку отметки. Страница за пределом списка —
// устаревшая кнопка: отметки сняли, пока сообщение висело, и она показывает
// последнюю страницу.
//
// Лот, которого Auction не знает или не показывает (`findLot` без ответа),
// из списка выпадает до нарезки страниц: аукцион могли удалить до торгов, а
// отметка живёт в Notifications до своего срока, и страница из таких лотов
// не должна закрывать дорогу к остальным. Закрытый лот Auction отдаёт, и он
// остаётся со своим итогом. Любой другой отказ — сбой соседа: он бросается,
// и человек получает повтор, а не неполный список.
export async function openFavorites(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  page: number;
  auctionId?: string;
}): Promise<AuctionScreenBody> {
  if (input.favorites === undefined) {
    throw new Error("favorites are not configured");
  }
  const { viewer } = input;
  // Стадия аукциона нужна только тексту сводки: её отказ список не роняет.
  const ended =
    input.auctionId === undefined
      ? Promise.resolve(false)
      : input.auction.getAuction({ viewer, auctionId: input.auctionId }).then(
          (auction) =>
            auction?.stage === "finished" || auction?.stage === "cancelled",
          () => false,
        );
  const ids = await input.favorites.listFollowedLots(viewer);
  const found = await Promise.all(
    ids.map((lotId) => input.auction.findLot({ viewer, lotId })),
  );
  const all = found
    .filter((lot): lot is LotView => lot !== undefined)
    .slice(0, MAX_FAVORITES);
  const pageCount = Math.max(1, Math.ceil(all.length / FEED_PAGE_SIZE));
  const page = Math.min(input.page, pageCount - 1);
  const lots = all.slice(page * FEED_PAGE_SIZE, (page + 1) * FEED_PAGE_SIZE);
  const listButton = (target: number) =>
    encodeAuctionCallback({
      kind: "favorites",
      page: target,
      ...(input.auctionId === undefined ? {} : { auctionId: input.auctionId }),
    });
  const paging: AuctionButton[] = [
    ...(page > 0
      ? [
          {
            action: "favorites.prev" as const,
            callbackData: listButton(page - 1),
          },
        ]
      : []),
    ...(page < pageCount - 1
      ? [
          {
            action: "favorites.next" as const,
            callbackData: listButton(page + 1),
          },
        ]
      : []),
  ];
  return {
    blocks: [
      {
        kind: "favorites",
        page,
        pageCount,
        lots: lots.map((lot) => feedItemOf(lot, viewer)),
        ...withMine(mineOf(all, viewer)),
        total: all.length,
        // Список общий на все аукционы: «закончен» говорится, только когда
        // все его лоты — из этого аукциона, иначе итогами назвались бы лоты
        // идущего аукциона.
        ...((await ended) &&
        all.every((lot) => lot.auctionId === input.auctionId)
          ? { ended: true as const }
          : {}),
      },
    ],
    keyboard: [
      ...lots.map((lot) => [
        {
          action: "favorites.open-lot" as const,
          lotId: lot.lotId,
          // Карточка возвращает в ленту своего аукциона, а не в список:
          // родитель лота — лента (дизайн-код, «Дерево бота аукциона»).
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page: 0,
          }),
        },
      ]),
      ...(paging.length > 0 ? [paging] : []),
      ...(input.auctionId === undefined
        ? []
        : [
            [
              {
                action: "favorites.back" as const,
                callbackData: encodeAuctionCallback({
                  kind: "root",
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]),
    ],
  };
}
