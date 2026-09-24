import type { MeetupSchedule } from "./meetups/port.js";

/// Имя пояса IANA, которое понимает `Intl`, или `undefined`. Неизвестное имя —
/// отказ, а не откат к UTC: опечатка в конфигурации должна останавливать
/// процесс, а не сдвигать показанное время на разницу поясов.
export function parseTimeZone(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return undefined;
  }
}

/// Мгновение RFC 3339 из Meetups в местную дату и время сообщества с точностью
/// до минуты — тот же вид, в котором момент вводится. Непонятная строка —
/// нарушение контракта, а не «публикация не назначена»: молча потерянный
/// момент показал бы черновик, который на деле ждёт публикации.
export function communityLocalTime(
  instant: string,
  timeZone: string,
): MeetupSchedule {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`scheduled_publish_at is not an RFC 3339 instant`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hours: part("hour"),
    minutes: part("minute"),
  };
}
