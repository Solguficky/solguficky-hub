import type { ApplicationCursor } from "./port.js";

// Курсор, с которого очередь начинается ровно с этой заявки, если она ещё
// открыта: тот же момент и предшествующий UUID, и сравнение «(момент, id)
// больше курсора» у Identity отдаёт её первой. Момент на миллисекунду раньше
// тут не годится: у двух заявок одной миллисекунды он вернул бы первую. Читают
// им экран заявки по кнопке и оповещение о ней при доставке (PER-634).
export function cursorAtApplication({
  applicationId,
  createdAtMs,
}: ApplicationCursor): ApplicationCursor {
  return { createdAtMs, applicationId: previousUuid(applicationId) };
}

function previousUuid(uuid: string): string {
  const value = BigInt(`0x${uuid.replaceAll("-", "")}`);
  // Нулевого UUIDv7 не бывает; на нём курсор просто начнёт с момента.
  const hex = (value === 0n ? 0n : value - 1n).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
