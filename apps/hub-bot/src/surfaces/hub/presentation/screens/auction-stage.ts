import type {
  AuctionStageView,
  AuctionSummaryView,
} from "../../../../auction-ui/index.js";
import { marked, pictogram } from "../../../../core/pictograms.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { readableMoment } from "./kit.js";

// Стадия аукциона словом — одна у его корня (PER-605) и у строки аукциона на
// карточке сходки (PER-594): «ключ: значение» без точки, как строки карточки.
export const stageWords: Record<AuctionStageView, string> = {
  draft: "готовится",
  scheduled: "скоро старт",
  prebidding: "идут онлайн-торги",
  settling: "подводим итоги онлайн-торгов",
  "on-break": "перерыв перед финалом",
  "lineup-frozen": "готовим финал",
  "in-final": "идёт финал",
  finished: "завершён",
  cancelled: "отменён",
};

/**
 * Стадия со знаком видимости (PER-673): скрытый аукцион видит только
 * держатель `run_auctions`, и ему корень и карточка говорят «скрыт от
 * участников». Видимый аукцион знака не несёт: его видят все.
 */
export function stageLine(auction: AuctionSummaryView): string {
  const words = stageWords[auction.stage];
  return auction.hidden === true ? `${words}, скрыт от участников` : words;
}

/**
 * Строка аукциона на карточке сходки (PER-594; ADR-064, дополнение
 * 2026-10-12): стадия словом, а у онлайн-торгов с дедлайном — и срок, «🔨
 * Аукцион: идут онлайн-торги до 12 июня, сб, 19:00». Знак — раздела аукциона,
 * тот же, что у его кнопок (PER-644). Остальное об аукционе — в его корне за
 * «🧩 Расширения».
 */
export function auctionStateLine(
  auction: AuctionSummaryView,
  timeZone: string,
  today: CommunityDay,
): string {
  const words = stageLine(auction);
  const lead = marked(pictogram.auction, "Аукцион:");
  return auction.stage === "prebidding" && auction.closesAt !== undefined
    ? `${lead} ${words} до ${readableMoment(
        communityLocalTime(auction.closesAt, timeZone),
        today,
      )}`
    : `${lead} ${words}`;
}

/**
 * Последствие отмены аукциона словами ADR-064 (дополнение 2026-10-12): его
 * называют и подтверждение отмены в пульте, и подтверждение отмены сходки с
 * идущими торгами. Без числа — Auction не ответил, и подтверждение сходки
 * называет последствие условно (PER-606).
 */
export function auctionCancelConsequence(sold?: number): string {
  return sold === undefined
    ? "Если у сходки идут торги, аукцион будет отменён; проданные лоты останутся проданными."
    : `У сходки идут торги: аукцион будет отменён, проданные лоты (${sold}) останутся проданными.`;
}
