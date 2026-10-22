import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionPort,
  FavoritesPort,
  PredictionRoundView,
  Viewer,
} from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import { hasInvoices } from "./invoices.js";
import { hasRaffle } from "./open-feed.js";

// Корень аукциона (PER-605; ADR-064, дополнение 2026-10-12): стадия и сроки,
// вход в лоты, в прогнозы, пока участнику есть что отправить или перечитать
// (PER-489), в розыгрыш, пока Auction его отдаёт, и, у процесса с
// Notifications, в избранное. Корень один у двух ботов (PER-644, решение
// владельца по прогону 14 октября 2026 года): лента, прогнозы, розыгрыш и
// избранное возвращают в него. Остальные ряды — правила, пульт и возврат — ставит
// оболочка поверхности.
//
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Отказ чтения аукциона и прогнозов бросается, как у ленты; отказ чтения
// розыгрыша убирает его кнопку, а не роняет корень. Прогнозы читаются
// параллельно аукциону, но их отказ учитывается, только когда аукцион есть:
// удалённому Auction отвечает на прогнозы `NOT_FOUND`, а корень должен
// сказать «не найден».
export async function openRoot(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<AuctionScreenBody> {
  const raffleRead = hasRaffle(input);
  const predictionRead = predictionEntryRound(input).then(
    (round) => ({ ok: true as const, round }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const invoicesRead = hasInvoices(input);
  const auction = await input.auction.getAuction({
    viewer: input.viewer,
    auctionId: input.auctionId,
  });
  const [raffle, predictions, invoices] = await Promise.all([
    raffleRead,
    predictionRead,
    invoicesRead,
  ]);
  if (auction !== undefined && !predictions.ok) throw predictions.error;
  const predictionRound = predictions.ok ? predictions.round : undefined;
  if (auction === undefined) {
    return {
      blocks: [{ kind: "root", auctionId: input.auctionId }],
      keyboard: [],
    };
  }
  return {
    blocks: [{ kind: "root", auctionId: input.auctionId, auction }],
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
        ...(raffle
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
// если участнику есть что перечитать. Ошибка чтения уходит на границу, чтобы
// она не скрыла ни сбой зависимости, ни дефект ответа.
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
