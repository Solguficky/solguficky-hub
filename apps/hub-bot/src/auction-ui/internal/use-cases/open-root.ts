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
// его отдаёт, в промо-видео парой с лотами, пока оно есть и чат медиа включён
// (PER-774, PER-798), и,
// у процесса с Notifications, в избранное. Корень один у двух
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
  achievements?: import("../../achievement-types.js").AchievementsPort;
  media?: true;
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
  const achievementsRead =
    auction === undefined || input.achievements === undefined
      ? Promise.resolve(false)
      : input.achievements.getEvent(input.auctionId).then(
          (rows) => rows.length > 0,
          (cause) => {
            input.achievements?.reportFailure?.(cause);
            return true;
          },
        );
  const [raffle, predictionRound, invoices, hasAchievements] =
    await Promise.all([
      raffleRead,
      predictionRead,
      invoicesRead,
      achievementsRead,
    ]);
  if (auction === undefined) {
    return {
      blocks: [{ kind: "root", auctionId: input.auctionId }],
      keyboard: [],
    };
  }
  const raffleButtons =
    raffle !== undefined
      ? [
          {
            action: "root.raffle" as const,
            callbackData: encodeAuctionCallback({
              kind: "raffle",
              auctionId: input.auctionId,
            }),
          },
        ]
      : [];
  const predictionsButtons =
    predictionRound !== undefined
      ? [
          {
            action: "root.predictions" as const,
            callbackData: encodeAuctionCallback({
              kind: "prediction",
              auctionId: input.auctionId,
              round: predictionRound,
            }),
          },
        ]
      : [];
  const resultsButtons =
    auction.stage === "finished"
      ? [
          {
            action: "root.prediction-results" as const,
            callbackData: encodeAuctionCallback({
              kind: "prediction-results",
              auctionId: input.auctionId,
            }),
          },
        ]
      : [];
  // «Розыгрыш» и «Прогнозы» — парой под «Лотами» (решение владельца по
  // прогону stage 27.10, PER-798; пересматривает №66 прогона 14.10): без
  // «Прогнозов» розыгрышу в пару идут «Итоги», а то, чему пары не нашлось, —
  // своим рядом.
  const hasPredictions = predictionsButtons.length > 0;
  const paired = hasPredictions ? predictionsButtons : resultsButtons;
  const rest = hasPredictions ? resultsButtons : [];
  const raffleAndPredictionRows = [[...raffleButtons, ...paired], rest].filter(
    (row) => row.length > 0,
  );
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
      // «🏷️ Лоты» — главный вход, первым рядом парой с «🎬 Промо», пока
      // администратор выставил видео, а показать пост есть чем — чатом медиа
      // ботов (PER-774); без промо — своим рядом (решение владельца 27.10,
      // PER-798).
      [
        {
          action: "root.lots",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: input.auctionId,
            page: 0,
          }),
        },
        ...(input.media !== undefined && auction.promoVideo !== undefined
          ? [
              {
                action: "root.promo" as const,
                callbackData: encodeAuctionCallback({
                  kind: "promo",
                  auctionId: input.auctionId,
                }),
              },
            ]
          : []),
      ],
      ...raffleAndPredictionRows,
      ...(hasAchievements
        ? [
            [
              {
                action: "root.achievements" as const,
                callbackData: encodeAuctionCallback({
                  kind: "achievements",
                  auctionId: input.auctionId,
                  page: 0,
                }),
              },
            ],
          ]
        : []),
      // Хроники дня (PER-725): сводка последних суток, пока идёт онлайн-неделя
      // — от открытия торгов до закрытия последнего лота по дедлайну. Читает её
      // только держатель `place_bids`: держатель одного `run_auctions`, которого
      // хаб пускает в корень, получил бы отказ Auction, и кнопки у него нет.
      // «Статистики» всего аукциона (PER-770) в корне нет ни у кого: она —
      // вход в пульт хаба (PER-800, решение владельца по прогону 27.10).
      ...(input.viewer.rights.includes("place-bids") &&
      (auction.stage === "prebidding" || auction.stage === "settling")
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
