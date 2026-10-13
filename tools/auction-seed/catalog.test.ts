import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogError, parseCatalog, parseSchedule } from "./catalog.js";

const examplePath = fileURLToPath(
  new URL("./example/catalog.json", import.meta.url),
);

const meetup = {
  title: "Сходка",
  description: "",
  venue: "",
  startsAt: "20.10.2026 19:00",
};

const noFiles = () => Promise.reject(new Error("нет файла"));

async function problemsOf(catalog: unknown): Promise<readonly string[]> {
  try {
    await parseCatalog(JSON.stringify(catalog), "/catalogs/c.json", noFiles);
  } catch (cause) {
    if (cause instanceof CatalogError) return cause.problems;
    throw cause;
  }
  throw new Error("каталог принят");
}

describe("каталог наполнения", () => {
  it("пример из репозитория принимается целиком с фото", async () => {
    const catalog = await parseCatalog(
      await readFile(examplePath, "utf8"),
      examplePath,
    );
    expect(catalog.meetup.startsAt).toEqual({
      year: 2026,
      month: 10,
      day: 31,
      hours: 19,
      minutes: 0,
    });
    expect(catalog.lots).toHaveLength(10);
    expect(catalog.lots.filter((lot) => lot.image !== undefined)).toHaveLength(
      9,
    );
  });

  it("путь фото читается относительно файла каталога", async () => {
    const read: string[] = [];
    await parseCatalog(
      JSON.stringify({
        meetup,
        lots: [
          { title: "Лот", image: "photos/a.png", startingPrice: 100, step: 10 },
        ],
      }),
      "/catalogs/c.json",
      (path) => {
        read.push(path);
        return Promise.resolve(new Uint8Array([1]));
      },
    );
    // Путь разрешает платформа: на Windows корень получает букву диска.
    expect(read).toEqual([resolve("/catalogs/photos/a.png")]);
  });

  it("называет номер лота у каждой ошибки и все ошибки сразу", async () => {
    expect(
      await problemsOf({
        meetup,
        lots: [
          { title: "Лот", startingPrice: 100, step: 10 },
          { title: "Без шага", startingPrice: 100 },
          { title: "Копейки", startingPrice: 99.5, step: 10 },
          { title: "Фото", image: "нет.png", startingPrice: 100, step: 10 },
        ],
      }),
    ).toEqual([
      "лот 2: step: нужен шаг целыми рублями больше нуля",
      "лот 3: startingPrice: нужна стартовая цена целыми рублями больше нуля",
      "лот 4: image: файл нет.png не прочитан",
    ]);
  });

  it("отвергает сходку без названия и с датой не того вида", async () => {
    expect(
      await problemsOf({
        meetup: { title: " ", startsAt: "2026-10-20 19:00" },
        lots: [{ title: "Лот", startingPrice: 100, step: 10 }],
      }),
    ).toEqual([
      "meetup.title: нужна непустая строка",
      "meetup.startsAt: нужна дата вида «20.10.2026 19:00» во времени сообщества",
    ]);
  });

  it("отвергает пустой список лотов и не-JSON", async () => {
    expect(await problemsOf({ meetup, lots: [] })).toEqual([
      "lots: нужен непустой массив лотов",
    ]);
    await expect(parseCatalog("{", "/c.json", noFiles)).rejects.toThrow(
      /файл не JSON/,
    );
  });

  it("дата должна существовать в календаре", () => {
    expect(parseSchedule("31.02.2026 19:00")).toBeUndefined();
    expect(parseSchedule("20.10.2026 24:00")).toBeUndefined();
    expect(parseSchedule("01.11.2026 09:05")).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hours: 9,
      minutes: 5,
    });
  });
});
