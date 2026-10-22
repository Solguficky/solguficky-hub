import type { LotSetCollected } from "../../../gen/notifications/v1/notifications_pb.js";
import { lotWord, truncate } from "../format.js";
import { canonical } from "./lot-notice.js";

// Итог коллекционного сета (ADR-073, п. 7; PER-687): участнику его доставляет
// бот хаба, гостю — бот аукциона. Получатель уже назван фактом, поэтому права,
// подписки и настройки на доставке не проверяются. Состав лотов не едет в
// уведомлении: кнопка открывает существующий экран сета, который читает состав
// из снимка лота.

export type LotSetNotice = {
  kind: "lot-set-collected";
  setName: string;
  lotCount: number;
  lotId: string;
};

// Факт — ввод соседа: имя, число и lot id — всё, что нужно сообщению и его
// кнопке. Пустой сет не бывает собранным, а неканонический lot id уронил бы
// кодировщик кнопки. Пустое имя сета отсеивает Notifications при разборе
// факта Auction тем же правилом, что Auction, и здесь оно не повторяется.
export function lotSetNoticeOf(
  value: LotSetCollected,
): LotSetNotice | undefined {
  const lotId = canonical(value.lotId);
  if (value.lotCount < 2 || lotId === undefined) return undefined;
  return {
    kind: "lot-set-collected",
    setName: value.setName,
    lotCount: value.lotCount,
    lotId,
  };
}

export type LotSetNoticeButton = { lotId: string; text: string };
export type LotSetNoticeView = { text: string; button: LotSetNoticeButton };

const toLotSetLabel = "К сету";
// Имя сета пишет организатор: длинное обрезается, чтобы весть осталась одной
// фразой и с запасом укладывалась в предел текста Telegram.
const maxSetNameLength = 600;

// Одна фраза на «ты», без заголовка и шапки (дизайн-код, «Уведомления
// аукциона»). Состав открывается кнопкой на уже существующем экране сета.
export function renderLotSetNotice(notice: LotSetNotice): LotSetNoticeView {
  const setName = truncate(notice.setName, maxSetNameLength);
  return {
    text: `Ты собрал сет «${setName}»: в нём ${notice.lotCount} ${lotWord(notice.lotCount)}.`,
    button: { lotId: notice.lotId, text: toLotSetLabel },
  };
}
