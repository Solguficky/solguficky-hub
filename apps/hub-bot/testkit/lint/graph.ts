import type { Catalog } from "./catalog.js";
import type { LintConfig, ScreenViolation } from "./inspect.js";

// Граф дерева экранов по каталогу (PER-592): «из любого экрана „‹" за конечное
// число шагов приводит в корень». Правило `tree` линтера вызова проверяет
// только отрисованный экран — последний ряд `[‹ Родитель]`; что родитель
// существует и цепочка родителей кончается корнем, а не циклом и не обрывом,
// видно только по каталогу целиком. Поэтому граф проверяется отдельно, по
// записям, а не по вызовам: запись, которую ни один тест не отрисовал, тоже
// под проверкой.
//
// Вне графа — сообщения без дерева за ними: подтверждения возвращают туда,
// откуда открыты, кадры исхода несут свой выход (`exit`), кадры без доступа
// (`none`, `links`) и приветствие (`apply`) деревом не являются.

/** Нарушения графа каталога поверхности; пустой список — граф цел. */
export function inspectCatalog(config: LintConfig): ScreenViolation[] {
  const { catalog } = config;
  const found: ScreenViolation[] = [];
  const at = (screen: string, detail: string): ScreenViolation => ({
    screen,
    method: "catalog",
    rule: "graph",
    detail,
  });
  const screens = Object.entries(catalog).filter(
    ([, entry]) => entry.class === "screen",
  );
  const roots = screens.filter(([, entry]) => entry.nav === "root");
  if (roots.length !== 1) {
    found.push(
      at(
        roots.map(([id]) => id).join(", ") || "—",
        `корень в каталоге один — корневое меню, а их ${roots.length}`,
      ),
    );
  }
  const reaches = new Map<string, boolean>();
  for (const [id, entry] of screens) {
    if (entry.nav !== "tree") continue;
    if (entry.parent === undefined) {
      found.push(at(id, "у экрана дерева нет родителя"));
      continue;
    }
    const parents = parentsOf(config, entry.parent);
    if (parents.length === 0) {
      found.push(at(id, `группа родителей ${entry.parent} пуста`));
      continue;
    }
    const missing = parents.filter((parent) => catalog[parent] === undefined);
    if (missing.length > 0) {
      found.push(at(id, `родителя ${missing.join(", ")} в каталоге нет`));
      continue;
    }
    if (!parents.some((parent) => catalog[parent]?.backName !== undefined)) {
      found.push(
        at(id, `у родителя ${parents.join(" | ")} нет имени для «‹ …»`),
      );
    }
    if (!reachesRoot(config, id, reaches, new Set())) {
      found.push(at(id, "цепочка родителей не доходит до корня"));
    }
  }
  return found;
}

function parentsOf(config: LintConfig, parent: string): readonly string[] {
  return config.parentGroups?.[parent] ?? [parent];
}

// Каждый родитель экрана — и каждый экран группы — обязан дойти до корня:
// возврат ведёт в любой из них. Цикл на пути — недостижимость.
function reachesRoot(
  config: LintConfig,
  id: string,
  memo: Map<string, boolean>,
  path: Set<string>,
): boolean {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const entry: Catalog[string] | undefined = config.catalog[id];
  if (entry === undefined || path.has(id)) return false;
  if (entry.nav === "root") {
    memo.set(id, true);
    return true;
  }
  if (entry.nav !== "tree" || entry.parent === undefined) {
    memo.set(id, false);
    return false;
  }
  path.add(id);
  const ok = parentsOf(config, entry.parent).every((parent) =>
    reachesRoot(config, parent, memo, path),
  );
  path.delete(id);
  memo.set(id, ok);
  return ok;
}
