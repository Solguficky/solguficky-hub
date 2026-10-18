import { randomUUID } from "node:crypto";

// Канонический UUIDv7: время в старших байтах, остальное — случайное. Им бот
// рождает идентификаторы и `op_id` команд, которые проверяет Auction.
export function createUuidV7(now: number = Date.now()): string {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  let time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
