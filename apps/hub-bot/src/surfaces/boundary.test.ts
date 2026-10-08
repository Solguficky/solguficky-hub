import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  app,
  inside,
  relativeImports,
  shown,
  sources,
} from "../../testkit/imports.js";

// Граница поверхностей пакета ботов (ADR-064, п. 18): поверхность хаба и
// поверхность аукциона не импортируют код друг друга — общее у них только
// аукционное дерево `src/auction-ui`, сгенерированный код и пакеты `shared/`.
// Раньше это держала раскладка по двум приложениям; в одном пакете — этот
// тест. Выбор поверхности в `src/main.ts` — единственное место, которое знает
// обе.

const src = path.join(app, "src");
const tree = path.join(src, "auction-ui");
const auction = [
  path.join(src, "surfaces", "auction"),
  path.join(app, "testkit", "auction"),
];
const selector = path.join(src, "main.ts");

const isAuction = (file: string) => auction.some((dir) => inside(file, dir));
// Общее у поверхностей: дерево, `gen/`, `testkit/imports.ts` и всё вне пакета.
const isShared = (target: string) =>
  inside(target, tree) ||
  inside(target, path.join(src, "core")) ||
  inside(target, path.join(app, "gen")) ||
  target === path.join(app, "testkit", "imports.ts") ||
  inside(target, path.join(app, "testkit", "lint")) ||
  !inside(target, app);

const scanned = ["src", "testkit"].flatMap((dir) =>
  sources(path.join(app, dir)),
);

describe("surface boundary", () => {
  it("keeps the auction surface off the hub surface's code", () => {
    const crossings = scanned
      .filter(isAuction)
      .flatMap(relativeImports)
      .filter(({ target }) => !isAuction(target) && !isShared(target))
      .map(shown);
    expect(crossings).toEqual([]);
  });

  it("keeps the hub surface off the auction surface's code", () => {
    const crossings = scanned
      .filter((file) => !isAuction(file) && file !== selector)
      .flatMap(relativeImports)
      .filter(({ target }) => isAuction(target))
      .map(shown);
    expect(crossings).toEqual([]);
  });

  // Самопроверка: обе стороны видны сканеру, иначе пустые списки выше ничего
  // не доказывают.
  it("sees both surfaces importing the shared tree", () => {
    const importsTree = (file: string) =>
      relativeImports(file).some(({ target }) => inside(target, tree));
    expect(scanned.filter(isAuction).some(importsTree)).toBe(true);
    expect(scanned.filter((file) => !isAuction(file)).some(importsTree)).toBe(
      true,
    );
  });
});
