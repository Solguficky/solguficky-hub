import type { LotSetCollected } from "../../../gen/notifications/v1/notifications_pb.js";
import { lotWord, truncate } from "../format.js";

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
// Match Auction's LotSetName blank rule (Character.isWhitespace or isSpaceChar).
// String.trim() is broader: it treats U+FEFF as whitespace, which Auction does not.
const UNICODE_SEPARATOR = /^\p{Z}$/u;

function isBlankSetName(value: string): boolean {
  return value.split("").every((character) => {
    const code = character.charCodeAt(0);
    return (
      UNICODE_SEPARATOR.test(character) ||
      (code >= 0x09 && code <= 0x0d) ||
      (code >= 0x1c && code <= 0x1f)
    );
  });
}

// Факт — ввод соседа: имя, число и lot id — всё, что нужно сообщению и его
// кнопке. Пустой сет не бывает собранным, а неверный lot id не откроет экран.
export function lotSetNoticeOf(
  value: LotSetCollected,
): LotSetNotice | undefined {
  if (
    isBlankSetName(value.setName) ||
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
// A 600-unit name stays within Telegram's 4096-unit text limit after Hub HTML
// escaping, even if every character expands to `&quot;`.
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
