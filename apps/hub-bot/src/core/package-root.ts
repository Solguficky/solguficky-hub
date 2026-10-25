import { existsSync } from "node:fs";
import path from "node:path";

// Данные образа — записи «Что нового» и данные сборки — лежат в корне пакета:
// рядом с `package.json` и в исходниках (`src/core`), и в сборке
// (`dist/src/core`), и в образе (`/app`). Глубина у этих мест разная, поэтому
// корень ищется подъёмом, а не числом `..`; без `package.json` выше — рядом с
// модулем.
export function packageEntry(
  name: string,
  from: string = import.meta.dirname,
): string {
  let dir = from;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(from, name);
    dir = parent;
  }
  return path.join(dir, name);
}
