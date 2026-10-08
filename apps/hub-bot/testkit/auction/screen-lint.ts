import {
  inspectCall as inspectWith,
  type LintConfig,
  type ScreenEntry,
  type ScreenViolation,
  type UnknownEntryKeys,
} from "../../../../shared/typescript/screen-lint/src/index.js";
import {
  auctionListParent,
  auctionLists,
  screenCatalog,
  screenTag,
} from "../../src/surfaces/auction/screen-catalog.js";

// Линтер экрана бота аукциона: общий линтер дизайн-кода
// (`shared/typescript/screen-lint`) с каталогом этого бота. Именованных пар у
// его дерева нет, группа родителей одна — списки аукционов, в которые
// возвращает лента. Его зовёт записывающий трансформер `bot.test.ts`, а
// найденное снимает `lint-setup.ts`.

export {
  reportViolations,
  type ScreenEntry,
  type ScreenViolation,
  takeViolations,
} from "../../../../shared/typescript/screen-lint/src/index.js";

// Каталог объявлен без `satisfies` — сборка бота не видит пакета линтера, — и
// опечатку в необязательном поле записи ловит этот тип при typecheck.
const catalogShape: [UnknownEntryKeys<typeof screenCatalog>] extends [never]
  ? true
  : never = true;
void catalogShape;

function configFor(catalog: Readonly<Record<string, ScreenEntry>>): LintConfig {
  return {
    tag: screenTag,
    catalog,
    parentGroups: { [auctionListParent]: auctionLists },
  };
}

const auction = configFor(screenCatalog);

/** Каталог передаётся только тестом каталога; в работе он один. */
export function inspectCall(
  method: string,
  payload: unknown,
  catalog?: Readonly<Record<string, ScreenEntry>>,
): ScreenViolation[] {
  return inspectWith(
    catalog === undefined ? auction : configFor(catalog),
    method,
    payload,
  );
}
