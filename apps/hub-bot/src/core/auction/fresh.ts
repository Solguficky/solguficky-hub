import type { LotView } from "../../auction-ui/index.js";

// Чтение лота не старее версии (PER-470). `GetLot` читает read model Auction,
// а она отстаёт от команды на время проекции; ответ принятой ставки и лимита
// называет версию, с которой чтение показывает команду целиком. Карточка за
// «К лоту» дочитывает лот до неё — общий помощник обеих поверхностей.
//
// Паузы — по интервалу опроса журнала проекцией (200 мс, application.conf
// Auction), в сумме секунда: обычный догон укладывается в первую-вторую, а
// бюджет действия остаётся целым. Не догнал за них — карточка из последнего
// снимка, а не отказ: команда принята, и «Обновить» на карточке есть. Сбой
// дочитывания — включая исчерпанный бюджет действия — даёт то же.
export const FRESH_READ_PAUSES_MS: readonly number[] = [100, 200, 300, 400];

export type Pause = (ms: number) => Promise<void>;

export const realPause: Pause = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function readLotAtLeast(
  read: () => Promise<LotView>,
  atLeastVersion: number | undefined,
  pause: Pause = realPause,
): Promise<LotView> {
  // Первое чтение бросает как обычно: карточки без него нет.
  let lot = await read();
  if (atLeastVersion === undefined) return lot;
  for (const ms of FRESH_READ_PAUSES_MS) {
    if (lot.version >= atLeastVersion) return lot;
    await pause(ms);
    try {
      lot = await read();
    } catch {
      return lot;
    }
  }
  return lot;
}
