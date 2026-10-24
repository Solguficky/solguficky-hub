import { createHash, randomUUID } from "node:crypto";

// Канонический UUIDv7: время в старших байтах, остальное — случайное. Им бот
// рождает идентификаторы и `op_id` команд, которые проверяет Auction.
export function createUuidV7(now: number = Date.now()): string {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  return stampV7(bytes, now);
}

/**
 * UUIDv7 из ключа (PER-699): тот же ключ и момент дают тот же идентификатор.
 * Так `op_id` ответа ведущего выводится из самого сообщения Telegram, и
 * повторная доставка того же сообщения приходит в Auction повтором команды, а
 * не новой. Место случайных бит занимает SHA-256 ключа: у разных ключей
 * идентификаторы совпадают не чаще, чем у двух случайных UUIDv7.
 */
export function uuidV7Of(key: string, now: number): string {
  const bytes = Buffer.from(
    createHash("sha256").update(key).digest().subarray(0, 16),
  );
  // Вариант RFC 9562 — `10` в старших битах девятого байта: у `randomUUID`
  // он уже стоит, у хеша его ставит сам вывод.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return stampV7(bytes, now);
}

// Вписывает в 16 байт время и версию 7 — правит переданный буфер — и отдаёт
// каноническую запись.
function stampV7(bytes: Buffer, now: number): string {
  let time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
