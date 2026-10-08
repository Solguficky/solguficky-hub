import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  app,
  inside,
  isTest,
  relativeImports,
  shown,
  sources,
} from "../../testkit/imports.js";

// Граница аукционного дерева (ADR-044, «Доступ как обязательный шлюз»; шлюз в
// силе по ADR-064): бот входит в дерево только через `index.ts` — шлюз, порты,
// тело экрана, `callback_data` — и через `contract/index.ts` из тестов.
// Диспетчер и сырые юзкейсы проверку доступа не делают и снаружи не видны.
// Раньше это держали `exports` пакета; внутри одного приложения их нет.

const tree = path.join(app, "src", "auction-ui");
const contract = path.join(tree, "contract");
const entry = path.join(tree, "index.ts");
const contractEntry = path.join(contract, "index.ts");
const scanned = ["src", "testkit"].flatMap((dir) =>
  sources(path.join(app, dir)),
);

describe("auction tree boundary", () => {
  it("is entered only through its index and, from tests, its contract", () => {
    const crossings = scanned
      .filter((file) => !inside(file, tree))
      .flatMap(relativeImports)
      .filter(({ target }) => inside(target, tree))
      .filter(
        ({ file, target }) =>
          target !== entry && !(target === contractEntry && isTest(file)),
      )
      .map(shown);
    expect(crossings).toEqual([]);
  });

  // `contract/` зовёт vitest и в сборку не входит (`tsconfig.build.json`).
  // Импорт из прод-кода дерева втянул бы его в `dist` вопреки `exclude`, и
  // процесс упал бы на загрузке без vitest в образе.
  it("keeps the contract out of the tree's production code", () => {
    const leaks = scanned
      .filter(
        (file) =>
          inside(file, tree) && !inside(file, contract) && !isTest(file),
      )
      .flatMap(relativeImports)
      .filter(({ target }) => inside(target, contract))
      .map(shown);
    expect(leaks).toEqual([]);
  });

  // Самопроверка: сканер видит импорты бота в дерево, иначе пустые списки
  // выше ничего не доказывают.
  it("sees the bot importing the tree", () => {
    const seen = scanned
      .filter((file) => !inside(file, tree))
      .flatMap(relativeImports)
      .some(({ target }) => target === entry);
    expect(seen).toBe(true);
  });
});
