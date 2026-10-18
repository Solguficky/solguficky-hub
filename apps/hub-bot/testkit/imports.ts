import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Относительные импорты исходников пакета: на них держатся тесты границ —
// аукционного дерева (`src/auction-ui/boundary.test.ts`) и поверхностей
// (`src/surfaces/boundary.test.ts`). Внутри одного приложения `exports` пакета
// границ не держат, поэтому их держит чтение исходников.

export const app = path.resolve(import.meta.dirname, "..");

// `from "…"`, `import("…")`, `import "…"` и подмены vitest `vi.mock("…")`,
// `vi.importActual("…")`: подмена модуля тоже его называет.
const specifier =
  /\b(?:from|import|mock|importActual|importMock)\s*\(?\s*["']([^"']+)["']/g;

export function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

export const inside = (file: string, dir: string): boolean =>
  !path.relative(dir, file).startsWith("..");

export const isTest = (file: string): boolean =>
  file.endsWith(".test.ts") || inside(file, path.join(app, "testkit"));

export type Import = { file: string; target: string };

// Каждый относительный импорт файла — путём исходника `.ts`, на который он
// ведёт.
export function relativeImports(file: string): Import[] {
  return [...readFileSync(file, "utf8").matchAll(specifier)]
    .map((match) => match[1] ?? "")
    .filter((spec) => spec.startsWith("."))
    .map((spec) => ({
      file,
      target: path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts"),
    }));
}

export const shown = ({ file, target }: Import): Import => ({
  file: path.relative(app, file),
  target: path.relative(app, target),
});
