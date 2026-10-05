import type { NewLotId } from "../application/types.js";
import { tokenToUuid, uuidToToken } from "./meetup-deep-link.js";

// Идентификатор нового лота и его ключ создания (PER-319). Кнопка вопроса о
// названии несёт аукцион, лот и того, кому вопрос задан; два полных токена с id
// спрашиваемого в 64 байта не помещаются. Поэтому у нового лота значащие
// только первые девять байт UUIDv7 — время, версия, вариант и 18 случайных
// бит, — а хвост нулевой. Девять байт — ровно двенадцать символов base64url,
// они и есть ключ, и идентификатор восстанавливается из него целиком.
//
// Идентификатор остаётся каноническим UUIDv7: другой Auction не примет, а лента
// сходки упорядочена по `lot_id`, то есть по времени из его старших байт.
// Случайных бит хватает: совпасть должны ещё и миллисекунды двух нажатий
// «Добавить лот».

const keyLength = 12;
const zeroTail = "A".repeat(22 - keyLength);

/** Идентификатор нового лота из свежего UUIDv7: хвост обнуляется. */
export function newLotId(uuidV7: string): NewLotId {
  return newLotIdOf(uuidToToken(uuidV7).slice(0, keyLength));
}

/** Ключ создания: то, что от идентификатора нового лота едет в кнопке. */
export function newLotKey(id: NewLotId): string {
  return uuidToToken(id).slice(0, keyLength);
}

/** Идентификатор нового лота по ключу из кнопки вопроса. */
export function newLotIdOf(key: string): NewLotId {
  // Бренд ставится только здесь: значение собрано из ключа и нулевого хвоста,
  // поэтому `newLotKey` возвращает ровно этот ключ.
  return tokenToUuid(`${key}${zeroTail}`) as NewLotId;
}
