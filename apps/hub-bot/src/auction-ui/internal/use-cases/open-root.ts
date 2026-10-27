import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionPort,
  FavoritesPort,
  PredictionRoundView,
  Viewer,
} from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import { hasInvoices } from "./invoices.js";
import { readRaffle } from "./open-feed.js";

// Корень аукциона (PER-605; ADR-064, дополнение 2026-10-12): стадия, сроки и
// программа недели (PER-724) — окна и финал из сводки, розыгрыш из `getRaffle`,
// вход в лоты, в прогнозы, пока участнику есть что отправить или перечитать
// (PER-489), в хроники дня онлайн-недели (PER-725), в розыгрыш, пока Auction
// его отдаёт, и, у процесса с Notifications, в избранное. Корень один у двух
// ботов (PER-644, решение владельца по прогону 14 октября 2026 года): лента,
// прогнозы, хроники, розыгрыш и избранное возвращают в него. Остальные ряды —
// правила, пульт и возврат — ставит оболочка поверхности.
//
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Отказ чтения аукциона бросается, как у ленты; отказ чтения розыгрыша,
// прогнозов и счетов убирает их кнопку, а не роняет корень. Прогнозы Auction
// отдаёт только держателю `place_bids` (ADR-067), а хаб пускает в корень и
// без него — держателя `run_auctions` — и `PERMISSION_DENIED` здесь обычен
// (PER-703); удалённому аукциону на прогнозы приходит `NOT_FOUND`, и корень
// говорит «не найден» по чтению аукциона.
export async function openRoot(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<AuctionScreenBody> {
  const raffleRead = readRaffle(input);
  const predictionRead = predictionEntryRound(input).catch(() => undefined);
  const invoicesRead = hasInvoices(input);
  const auction = await input.auction.getAuction({
    viewer: input.viewer,
    auctionId: input.auctionId,
  });
  const [raffle, predictionRound, invoices] = await Promise.all([
    raffleRead,
    predictionRead,
    invoicesRead,
  ]);
  if (auction === undefined) {
    return {
      blocks: [{ kind: "root", auctionId: input.auctionId }],
      keyboard: [],
    };
  }
  return {
    blocks: [
      {
        kind: "root",
        auctionId: input.auctionId,
        auction,
        // Программа недели (PER-724): момент розыгрыша — пока регистрация
        // открыта; прошедшие моменты отсекает оболочка по своим часам.
        ...(raffle?.status === "open"
          ? { raffleClosesAt: raffle.closesAt }
          : {}),
      },
    ],
    keyboard: [
      // «Лоты» и «Розыгрыш» — одним рядом (решение владельца по прогону 14.10,
      // №66; пересматривает «Розыгрыш своим рядом» PER-669).
      [
        {
          action: "root.lots",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: input.auctionId,
            page: 0,
          }),
        },
        ...(raffle !== undefined
          ? [
              {
                action: "root.raffle" as const,
                callbackData: encodeAuctionCallback({
                  kind: "raffle",
                  auctionId: input.auctionId,
                }),
              },
            ]
          : []),
      ],
      ...(predictionRound === undefined
        ? []
        : [
            [
              {
                action: "root.predictions" as const,
                callbackData: encodeAuctionCallback({
                  kind: "prediction",
                  auctionId: input.auctionId,
                  round: predictionRound,
                }),
              },
            ],
          ]),
      ...(auction.stage === "finished"
        ? [
            [
              {
                action: "root.prediction-results" as const,
                callbackData: encodeAuctionCallback({
                  kind: "prediction-results",
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]
        : []),
      // Хроники дня (PER-725): сводка последних суток, пока идёт онлайн-неделя
      // — от открытия торгов до закрытия последнего лота по дедлайну. Читает её
      // только держатель `place_bids`: держатель одного `run_auctions`, которого
      // хаб пускает в корень, получил бы отказ Auction, и кнопки у него нет.
      ...((auction.stage === "prebidding" || auction.stage === "settling") &&
      input.viewer.rights.includes("place-bids")
        ? [
            [
              {
                action: "root.day-chronicle" as const,
                callbackData: encodeAuctionCallback({
                  kind: "day-chronicle",
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]
        : []),
      // Счета победителя (PER-322): вход есть, пока у смотрящего есть счета
      // аукциона; отказ чтения убирает кнопку, как у розыгрыша.
      ...(invoices
        ? [
            [
              {
                action: "root.invoices" as const,
                callbackData: encodeAuctionCallback({
                  kind: "invoices",
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]
        : []),
      // Вход в избранное — только отсюда (PER-644): не из «Настроек» и не из
      // меню бота. Список общий на все аукционы, аукцион в кнопке — возврат.
      ...(input.favorites === undefined
        ? []
        : [
            [
              {
                action: "root.favorites" as const,
                callbackData: encodeAuctionCallback({
                  kind: "favorites",
                  page: 0,
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]),
    ],
  };
}

// Вход показывается, пока можно отправлять прогноз, и остаётся после закрытия,
// если участнику есть что перечитать.
async function predictionEntryRound(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<PredictionRoundView["round"] | undefined> {
  const rounds = await input.auction.getMyPredictions({
    viewer: input.viewer,
    auctionId: input.auctionId,
  });
  const open = rounds.find((round) => round.status === "open");
  if (open !== undefined) return open.round;
  return [...rounds].reverse().find((round) => round.answers.length > 0)?.round;
}
