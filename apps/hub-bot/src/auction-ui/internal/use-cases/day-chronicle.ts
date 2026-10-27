import { encodeAuctionCallback } from "../../callback-data.js";
import { dayNominations } from "../../day-nominations.js";
import type { DayChronicleLot } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import type { CommandContext } from "./commands.js";

// Хроники дня (PER-725): та же сводка последних суток, что у пульта хаба, —
// «Спорнее всех», «Тёмная лошадка» и «Эпичная дуэль» — глазами участника.
// Номинации выбирает общий `dayNominations`, а названия читаются только у
// выбранных лотов: остальной реестр экрану не нужен.

type Chronicle = Extract<
  AuctionScreenBody["blocks"][number],
  { kind: "day-chronicle" }
>["chronicle"];

export async function openDayChronicle(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const view = await context.auction.getDayChronicle({
    viewer: context.viewer,
    auctionId,
  });
  return {
    blocks: [
      {
        kind: "day-chronicle",
        auctionId,
        chronicle: await chronicleOf(context, view.lots),
      },
    ],
    keyboard: [
      [
        {
          action: "day-chronicle.back",
          callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
        },
      ],
    ],
  };
}

async function chronicleOf(
  context: CommandContext,
  lots: readonly DayChronicleLot[],
): Promise<Chronicle> {
  if (lots.length === 0) return { kind: "no-lots" };
  if (lots.every((lot) => lot.bidCount === 0)) return { kind: "no-bids" };
  // Ставки до окна — всего минус окно: число за всю жизнь Auction читает после
  // окна, и ставка между чтениями лишь завышает «до», как у пульта.
  const { contested, darkHorse, duel } = dayNominations(
    lots.map((lot) => ({
      ...lot,
      bidsBefore: Math.max(0, lot.totalBidCount - lot.bidCount),
    })),
  );
  const titles = new Map<string, string | undefined>();
  for (const lot of [contested, darkHorse, duel]) {
    if (lot === undefined || titles.has(lot.lotId)) continue;
    titles.set(lot.lotId, await titleOf(context, lot.lotId));
  }
  const titled = (lotId: string) => {
    const title = titles.get(lotId);
    return title === undefined ? {} : { title };
  };
  return {
    kind: "nominated",
    ...(contested === undefined
      ? {}
      : {
          contested: {
            ...titled(contested.lotId),
            leaderChanges: contested.leaderChanges,
          },
        }),
    ...(darkHorse?.priceGrowth === undefined
      ? {}
      : {
          darkHorse: {
            ...titled(darkHorse.lotId),
            priceGrowth: darkHorse.priceGrowth,
            bidsBefore: darkHorse.bidsBefore,
          },
        }),
    ...(duel === undefined
      ? {}
      : {
          duel: { ...titled(duel.lotId), longestDuel: duel.longestDuel },
        }),
  };
}

// Название лота для номинации; общее со статистикой аукциона (PER-770).
export async function titleOf(
  context: CommandContext,
  lotId: string,
): Promise<string | undefined> {
  const lot = await context.auction.findLot({ viewer: context.viewer, lotId });
  const title = lot?.card?.title.trim() ?? "";
  return title === "" ? undefined : title;
}
