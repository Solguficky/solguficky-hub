import type { LotSetCollected } from "../../../gen/notifications/v1/notifications_pb.js";

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

const CANONICAL_UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Факт — ввод соседа: имя, число и lot id — всё, что нужно сообщению и его
// кнопке. Пустой сет не бывает собранным, а неверный lot id не откроет экран.
export function lotSetNoticeOf(
  value: LotSetCollected,
): LotSetNotice | undefined {
  if (
    value.setName.trim() === "" ||
    !Number.isInteger(value.lotCount) ||
    value.lotCount < 2 ||
    value.lotCount > 0xffff_ffff ||
    !CANONICAL_UUID_V7.test(value.lotId)
  ) {
    return undefined;
  }
  return {
    kind: "lot-set-collected",
    setName: value.setName,
    lotCount: value.lotCount,
    lotId: value.lotId,
  };
}

export type LotSetNoticeButton = { lotId: string; text: string };
export type LotSetNoticeView = { text: string; button: LotSetNoticeButton };

const toLotSetLabel = "К сету";

// Одна фраза на «ты», без заголовка и шапки (дизайн-код, «Уведомления
// аукциона»). Состав открывается кнопкой на уже существующем экране сета.
export function renderLotSetNotice(notice: LotSetNotice): LotSetNoticeView {
  return {
    text: `Ты собрал сет «${notice.setName}»: в нём ${notice.lotCount} ${lotWord(notice.lotCount)}.`,
    button: { lotId: notice.lotId, text: toLotSetLabel },
  };
}

function lotWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "лотов";
  if (ones === 1) return "лот";
  if (ones >= 2 && ones <= 4) return "лота";
  return "лотов";
}
