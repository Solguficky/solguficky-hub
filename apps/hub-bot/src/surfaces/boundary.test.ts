import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  app,
  type Import,
  inside,
  relativeImports,
  shown,
  sources,
} from "../../testkit/imports.js";

// Раскладка пакета ботов (ADR-064, пп. 18–19): общий код процесса — `src/core`,
// аукционное дерево `src/auction-ui` и `gen/` — у обеих поверхностей один, а
// свои у каждой только экраны, тексты и клиенты своего сценария в
// `src/surfaces/<поверхность>`. Поверхности не импортируют друг друга, а общий
// код не знает ни одной: функция, которой место у обеих, уходит в общий код, а
// не копируется. Знать обе поверхности могут только выбор процесса
// `src/main.ts` и test kit (`testkit/`): один kit гоняет обе поверхности.

const src = path.join(app, "src");
const testkit = path.join(app, "testkit");

type Zone =
  | "core"
  | "tree"
  | "hub"
  | "auction"
  | "kit"
  | "gen"
  | "main"
  | "outside";

const zoneOf = (file: string): Zone => {
  if (!inside(file, app)) return "outside";
  if (inside(file, path.join(app, "gen"))) return "gen";
  if (file === path.join(src, "main.ts")) return "main";
  if (inside(file, path.join(src, "auction-ui"))) return "tree";
  if (inside(file, path.join(src, "core"))) return "core";
  if (inside(file, path.join(testkit, "lint"))) return "core";
  if (file === path.join(testkit, "imports.ts")) return "core";
  if (file === path.join(testkit, "tracing.ts")) return "core";
  if (inside(file, path.join(src, "surfaces", "auction"))) return "auction";
  if (inside(file, path.join(src, "surfaces", "hub"))) return "hub";
  if (inside(file, testkit)) return "kit";
  // Сами тесты раскладки читают исходники и к поверхностям не относятся.
  return "core";
};

const allowed: Record<Zone, readonly Zone[]> = {
  // Перевод ответов Auction в словарь дерева общий, поэтому общий код знает
  // дерево; дерево общего кода не знает (его `boundary.test.ts`).
  core: ["core", "tree", "gen", "outside"],
  tree: ["tree", "gen", "outside"],
  // Тесты поверхности берут kit; kit знает обе, но поверхность через него
  // другую не импортирует: прямых импортов между ними тест не пропускает.
  hub: ["hub", "core", "tree", "kit", "gen", "outside"],
  auction: ["auction", "core", "tree", "kit", "gen", "outside"],
  kit: ["kit", "hub", "auction", "core", "tree", "gen", "outside"],
  gen: ["gen", "outside"],
  main: ["main", "core", "hub", "auction", "outside"],
  outside: [],
};

const scanned = ["src", "testkit"].flatMap((dir) =>
  sources(path.join(app, dir)),
);

const crossingsFrom = (zone: Zone): Import[] =>
  scanned
    .filter((file) => zoneOf(file) === zone)
    .flatMap(relativeImports)
    .filter(({ target }) => !allowed[zone].includes(zoneOf(target)))
    .map(shown);

describe("package layout", () => {
  it.each(["hub", "auction"] as const)(
    "keeps the %s surface off the other surface",
    (zone) => {
      expect(crossingsFrom(zone)).toEqual([]);
    },
  );

  it("keeps the shared core off both surfaces", () => {
    expect(crossingsFrom("core")).toEqual([]);
  });

  // Самопроверка: обе поверхности видны сканеру и берут общий код, иначе
  // пустые списки выше ничего не доказывают.
  it.each(["hub", "auction"] as const)(
    "sees the %s surface importing the core and the tree",
    (zone) => {
      const imports = scanned
        .filter((file) => zoneOf(file) === zone)
        .flatMap(relativeImports)
        .map(({ target }) => zoneOf(target));
      expect(imports).toContain("core");
      expect(imports).toContain("tree");
    },
  );
});
