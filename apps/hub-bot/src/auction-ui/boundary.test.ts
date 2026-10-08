import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Граница аукционного дерева (ADR-044, «Доступ как обязательный шлюз»; шлюз в
// силе по ADR-064): бот входит в дерево только через `index.ts` — шлюз, порты,
// тело экрана, `callback_data` — и через `contract/index.ts` из тестов.
// Диспетчер и сырые юзкейсы проверку доступа не делают и снаружи не видны.
// Раньше это держали `exports` пакета; внутри одного приложения их держит
// этот тест.

const tree = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(tree, "../..");
const scanned = ["src", "testkit"].map((dir) => path.join(app, dir));
const specifier = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const entries = new Set([
  path.join(tree, "index.ts"),
  path.join(tree, "contract", "index.ts"),
]);
const testOnly = path.join(tree, "contract", "index.ts");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const isTest = (file: string) => file.endsWith(".test.ts");
const inside = (file: string, dir: string) =>
  !path.relative(dir, file).startsWith("..");

type Crossing = { file: string; target: string };

// Каждый относительный импорт снаружи дерева, который ведёт внутрь него.
function crossings(): Crossing[] {
  return scanned
    .flatMap(sources)
    .filter((file) => !inside(file, tree))
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(specifier)]
        .map((match) => match[1] ?? "")
        .filter((spec) => spec.startsWith("."))
        .map((spec) => ({
          file: path.relative(app, file),
          target: path
            .resolve(path.dirname(file), spec)
            .replace(/\.js$/, ".ts"),
          test: isTest(file) || inside(file, path.join(app, "testkit")),
        }))
        .filter((each) => inside(each.target, tree))
        .filter(
          (each) =>
            !entries.has(each.target) ||
            (each.target === testOnly && !each.test),
        )
        .map(({ file, target }) => ({
          file,
          target: path.relative(app, target),
        })),
    );
}

describe("auction tree boundary", () => {
  it("is entered only through its index and, from tests, its contract", () => {
    expect(crossings()).toEqual([]);
  });

  // Самопроверка: сканер видит импорты бота в дерево, иначе пустой список
  // выше ничего не доказывает.
  it("sees the bot importing the tree", () => {
    const seen = scanned
      .flatMap(sources)
      .filter((file) => !inside(file, tree))
      .some((file) =>
        [...readFileSync(file, "utf8").matchAll(specifier)].some((match) =>
          (match[1] ?? "").includes("auction-ui/index.js"),
        ),
      );
    expect(seen).toBe(true);
  });
});
