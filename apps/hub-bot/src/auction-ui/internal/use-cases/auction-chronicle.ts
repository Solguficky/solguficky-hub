import { encodeAuctionCallback } from "../../callback-data.js";
import { dayNominations } from "../../day-nominations.js";
import type { AuctionChronicleView } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import type { CommandContext } from "./commands.js";
import { titleOf } from "./day-chronicle.js";

// Статистика аукциона (PER-770): счётчики всех торгов, рекорд роста и
// номинации за весь аукцион глазами участника. «Спорнее всех» и «Эпичную
// дуэль» выбирает тот же `dayNominations`, что у хроник дня; «тёмной лошадки»
// нет — ставок «до окна» у окна во весь аукцион не бывает, и номинация
// совпала бы с рекордом роста, который выбрал Auction. Названия читаются
// только у названных лотов.

type Chronicle = Extract<
  AuctionScreenBody["blocks"][number],
  { kind: "auction-chronicle" }
>["chronicle"];

export async function openAuctionChronicle(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const view = await context.auction.getAuctionChronicle({
    viewer: context.viewer,
    auctionId,
  });
  return {
    blocks: [
      {
        kind: "auction-chronicle",
        auctionId,
        chronicle: await chronicleOf(context, view),
      },
    ],
    keyboard: [
      [
        {
          action: "auction-chronicle.back",
          callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
        },
      ],
    ],
  };
}

async function chronicleOf(
  context: CommandContext,
  view: AuctionChronicleView,
): Promise<Chronicle> {
  if (view.lots.length === 0) return { kind: "no-lots" };
  if (view.bidCount === 0) return { kind: "no-bids" };
  const { contested, duel } = dayNominations(
    view.lots.map((lot) => ({ ...lot, bidsBefore: 0 })),
  );
  const { growthRecord } = view;
  const titles = new Map<string, string | undefined>();
  for (const lotId of [growthRecord?.lotId, contested?.lotId, duel?.lotId]) {
    if (lotId === undefined || titles.has(lotId)) continue;
    titles.set(lotId, await titleOf(context, lotId));
  }
  const titled = (lotId: string) => {
    const title = titles.get(lotId);
    return title === undefined ? {} : { title };
  };
  return {
    kind: "counted",
    bidCount: view.bidCount,
    participantCount: view.participantCount,
    tradedLotCount: view.tradedLotCount,
    lotCount: view.lots.length,
    ...(growthRecord === undefined
      ? {}
      : {
          growthRecord: {
            ...titled(growthRecord.lotId),
            growth: growthRecord.growth,
          },
        }),
    ...(contested === undefined
      ? {}
      : {
          contested: {
            ...titled(contested.lotId),
            leaderChanges: contested.leaderChanges,
          },
        }),
    ...(duel === undefined
      ? {}
      : {
          duel: { ...titled(duel.lotId), longestDuel: duel.longestDuel },
        }),
  };
}
