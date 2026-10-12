import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Каталог наполнения stage (PER-613): одна сходка и лоты её аукциона. Файл —
// JSON, а не YAML: разбор не тянет новой зависимости. Каталог проверяется
// целиком до первого вызова сервисов, и отказ перечисляет все ошибки сразу с
// номером лота, а не первую: исправлять файл по одной строке за запуск дорого,
// когда каждый запуск заводит новую сходку.

export type CatalogSchedule = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
};

export type CatalogLot = {
  title: string;
  description: string;
  // Байты файла фото; формат решает Auction (ADR-057), здесь только чтение.
  image?: Uint8Array;
  imagePath?: string;
  // Целые рубли: так их вводит администратор в форме лота.
  startingPriceRubles: number;
  stepRubles: number;
};

export type Catalog = {
  meetup: {
    title: string;
    description: string;
    venue: string;
    startsAt: CatalogSchedule;
  };
  lots: readonly CatalogLot[];
};

export class CatalogError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `каталог не принят:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    this.name = "CatalogError";
    this.problems = problems;
  }
}

// Больше лотов в ленте не бывает (дизайн-код, «Лента»), а десятки лотов на
// stage — ошибка файла, а не тест.
const maxLots = 200;

// Тот же формат, что дата в форме сходки бота: время сообщества.
const schedulePattern = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

export function parseSchedule(raw: string): CatalogSchedule | undefined {
  const match = schedulePattern.exec(raw);
  if (match === null) return undefined;
  const [day, month, year, hours, minutes] = match
    .slice(1)
    .map((part) => Number(part));
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hours === undefined ||
    minutes === undefined
  ) {
    return undefined;
  }
  // Дата без часового пояса: проверяется только существование дня в календаре.
  const probe = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hours ||
    probe.getUTCMinutes() !== minutes
  ) {
    return undefined;
  }
  return { year, month, day, hours, minutes };
}

type FileReader = (path: string) => Promise<Uint8Array>;

/**
 * Разбирает текст каталога. Пути фото — относительно файла каталога, чтобы
 * каталог переносился вместе с папкой фото.
 */
export async function parseCatalog(
  text: string,
  catalogPath: string,
  read: FileReader = (path) => readFile(path),
): Promise<Catalog> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CatalogError([
      `файл не JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
  const problems: string[] = [];
  if (!isRecord(raw)) throw new CatalogError(["корень каталога — не объект"]);

  const meetup = raw["meetup"];
  let parsedMeetup: Catalog["meetup"] | undefined;
  if (!isRecord(meetup)) {
    problems.push("нет объекта meetup");
  } else {
    const title = trimmedText(meetup["title"]);
    const startsAt =
      typeof meetup["startsAt"] === "string"
        ? parseSchedule(meetup["startsAt"])
        : undefined;
    if (title === undefined || title === "") {
      problems.push("meetup.title: нужна непустая строка");
    }
    if (startsAt === undefined) {
      problems.push(
        "meetup.startsAt: нужна дата вида «20.10.2026 19:00» во времени сообщества",
      );
    }
    const description = optionalText(meetup["description"]);
    const venue = optionalText(meetup["venue"]);
    if (description === undefined)
      problems.push("meetup.description: нужна строка");
    if (venue === undefined) problems.push("meetup.venue: нужна строка");
    if (
      title !== undefined &&
      title !== "" &&
      startsAt !== undefined &&
      description !== undefined &&
      venue !== undefined
    ) {
      parsedMeetup = { title, description, venue, startsAt };
    }
  }

  const lots = raw["lots"];
  const parsedLots: CatalogLot[] = [];
  if (!Array.isArray(lots) || lots.length === 0) {
    problems.push("lots: нужен непустой массив лотов");
  } else if (lots.length > maxLots) {
    problems.push(`lots: не больше ${maxLots} лотов`);
  } else {
    const base = dirname(resolve(catalogPath));
    for (const [index, lot] of lots.entries()) {
      const name = `лот ${index + 1}`;
      if (!isRecord(lot)) {
        problems.push(`${name}: не объект`);
        continue;
      }
      const title = trimmedText(lot["title"]);
      const description = optionalText(lot["description"]);
      const startingPriceRubles = lot["startingPrice"];
      const stepRubles = lot["step"];
      const lotProblems: string[] = [];
      if (title === undefined || title === "")
        lotProblems.push("title: нужна непустая строка");
      if (description === undefined)
        lotProblems.push("description: нужна строка");
      if (!isWholeRubles(startingPriceRubles))
        lotProblems.push(
          "startingPrice: нужна стартовая цена целыми рублями больше нуля",
        );
      if (!isWholeRubles(stepRubles))
        lotProblems.push("step: нужен шаг целыми рублями больше нуля");
      let image: Uint8Array | undefined;
      let imagePath: string | undefined;
      const rawImage = lot["image"];
      if (rawImage !== undefined) {
        if (typeof rawImage !== "string" || rawImage === "") {
          lotProblems.push("image: нужен путь к файлу фото");
        } else {
          imagePath = resolve(base, rawImage);
          try {
            image = await read(imagePath);
          } catch {
            lotProblems.push(`image: файл ${rawImage} не прочитан`);
          }
        }
      }
      problems.push(...lotProblems.map((problem) => `${name}: ${problem}`));
      if (
        lotProblems.length === 0 &&
        title !== undefined &&
        description !== undefined &&
        isWholeRubles(startingPriceRubles) &&
        isWholeRubles(stepRubles)
      ) {
        parsedLots.push({
          title,
          description,
          startingPriceRubles,
          stepRubles,
          ...(image === undefined ? {} : { image }),
          ...(imagePath === undefined ? {} : { imagePath }),
        });
      }
    }
  }

  if (problems.length > 0 || parsedMeetup === undefined) {
    throw new CatalogError(problems);
  }
  return { meetup: parsedMeetup, lots: parsedLots };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

// Необязательное текстовое поле: отсутствие — пустая строка, не строка — ошибка.
function optionalText(value: unknown): string | undefined {
  if (value === undefined) return "";
  return trimmedText(value);
}

function isWholeRubles(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
