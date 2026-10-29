// Форма текста, общая у двух ботов: цена и обрезка строки нужны экранам
// аукциона обеих поверхностей и вестям о лотах (`notifications/lot-notice.ts`).

export type FormattedMoney = { minorUnits: number; currency: string };

/** Читаемая дата с годом только вне текущего года сообщества. */
export function readableInstant(input: {
  instant: string;
  timeZone: string;
  now?: Date;
}): string {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: input.timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(input.instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const currentYear = formatter
    .formatToParts(input.now ?? new Date())
    .find((p) => p.type === "year")?.value;
  const year = part("year") === currentYear ? "" : ` ${part("year")}`;
  return `${part("day")} ${part("month")}${year}, ${part("weekday")}, ${part("hour")}:${part("minute")}`;
}

// Валюта у платформы одна — рубль, и у неё две цифры после запятой. Копейки
// показываются, только когда они есть.
export function money(amount: FormattedMoney): string {
  const whole = amount.minorUnits % 100 === 0;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount.minorUnits / 100);
}

// Обрезка по кодовым точкам: срез по UTF-16 разрезал бы суррогатную пару, и
// Telegram получил бы битую строку. Кодовая точка длиннее единицы UTF-16 не
// бывает короче, поэтому результат укладывается в `limit` единиц.
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > Math.max(0, limit - 1)) break;
    kept += point;
  }
  return `${kept}…`;
}

/** Russian word for a lot count in nominative case. */
export function lotWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "лотов";
  if (ones === 1) return "лот";
  if (ones >= 2 && ones <= 4) return "лота";
  return "лотов";
}
