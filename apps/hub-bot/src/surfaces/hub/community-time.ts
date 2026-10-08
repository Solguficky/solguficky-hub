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

export type CommunityDay = { year: number; month: number; day: number };

/// Сегодняшний день сообщества — тот, по которому Meetups решает, ушла ли
/// планируемая сходка в архив (meetups.md). Сравнение идёт по дню, а не по
/// моменту: сходка сегодня в прошедший час остаётся в «Ближайших».
export function communityDay(now: Date, timeZone: string): CommunityDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const today = { year: part("year"), month: part("month"), day: part("day") };
  // Непонятный ответ `Intl` — отказ, а не «дата не прошла»: сравнение с NaN
  // ложно, и вопрос о прошедшей дате молча бы исчез.
  if (Object.values(today).some(Number.isNaN)) {
    throw new Error(`cannot read the community day in ${timeZone}`);
  }
  return today;
}

export function isBeforeDay(value: CommunityDay, today: CommunityDay): boolean {
  if (value.year !== today.year) return value.year < today.year;
  if (value.month !== today.month) return value.month < today.month;
  return value.day < today.day;
}

/// Местные дата и время сообщества в мгновение RFC 3339 в UTC — обратный ход
/// `communityLocalTime` для сервиса, который принимает мгновения, а не местное
/// время (Auction, PER-320). Смещение пояса берётся дважды: от наивной догадки
/// и от первого приближения, — так переход часов между ними не сдвигает ответ.
/// Времени, которого в поясе нет, — часы перевели вперёд — ответа нет:
/// обратный перевод его не воспроизводит, и подменять его соседним бот не
/// вправе.
export function communityInstant(
  local: MeetupSchedule,
  timeZone: string,
): string | undefined {
  const naive = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hours,
    local.minutes,
  );
  const offset = (at: number) => {
    const shown = communityLocalTime(new Date(at).toISOString(), timeZone);
    return (
      Date.UTC(
        shown.year,
        shown.month - 1,
        shown.day,
        shown.hours,
        shown.minutes,
      ) - at
    );
  };
  const first = naive - offset(naive);
  const instant = naive - offset(first);
  const back = communityLocalTime(new Date(instant).toISOString(), timeZone);
  if (
    back.year !== local.year ||
    back.month !== local.month ||
    back.day !== local.day ||
    back.hours !== local.hours ||
    back.minutes !== local.minutes
  ) {
    return undefined;
  }
  return new Date(instant).toISOString().replace(".000Z", "Z");
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
