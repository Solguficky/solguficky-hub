// Каталог функций — это не просто папка с кодом, а список того, что Netlify
// зарегистрирует при деплое: каждый файл рядом с обработчиком становится
// отдельной функцией, а его имя — именем функции. Имя с точкой Netlify не
// принимает и отказывает всему деплою целиком, вместе со статикой.
//
// Проверка стоит здесь, а не в деплой-workflow, намеренно: она нужна до мержа.
// Отказ на деплое случается уже после него — на `develop`, где чинить дороже
// и виднее всем.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FUNCTIONS_DIR = fileURLToPath(
  new URL("../netlify/functions/", import.meta.url),
);

/** Требование Netlify к имени функции: только буквы, цифры, дефис и нижнее
 *  подчёркивание. Точка в имени — самый лёгкий способ его нарушить, потому что
 *  так называются тесты и типы рядом с кодом. */
const VALID_NAME = /^[A-Za-z0-9_-]+$/;

describe("каталог функций пригоден для деплоя", () => {
  const entries = readdirSync(FUNCTIONS_DIR, { withFileTypes: true });

  it("в каталоге есть хотя бы одна функция", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    it(`${entry.name} — допустимое имя функции`, () => {
      // Имя функции — это имя файла без расширения; у каталога-функции именем
      // служит сам каталог.
      const name = entry.isDirectory()
        ? entry.name
        : entry.name.slice(0, entry.name.lastIndexOf("."));
      expect(name).toMatch(VALID_NAME);
    });
  }
});
