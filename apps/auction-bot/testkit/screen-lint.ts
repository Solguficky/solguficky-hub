import {
  inspectCall as inspectWith,
  type LintConfig,
  type ScreenEntry,
  type ScreenViolation,
  type UnknownEntryKeys,
} from "../../../shared/typescript/screen-lint/src/index.js";
import { screenCatalog, screenTag } from "../src/screen-catalog.js";

// Линтер экрана бота аукциона: общий линтер дизайн-кода
// (`shared/typescript/screen-lint`) с каталогом этого бота. Именованных пар и
// групп родителей у его дерева нет. Его зовёт записывающий трансформер
// `bot.test.ts`, а найденное снимает `lint-setup.ts`.

export {
  inspectCall as inspectWith,
  reportViolations,
  type ScreenEntry,
  type ScreenViolation,
  takeViolations,
  type WaivableRule,
} from "../../../shared/typescript/screen-lint/src/index.js";

// Каталог объявлен без `satisfies` — сборка бота не видит общего пакета, — и
// опечатку в необязательном поле записи ловит этот тип при typecheck.
const catalogShape: [UnknownEntryKeys<typeof screenCatalog>] extends [never]
  ? true
  : never = true;
void catalogShape;

export function configFor(
  catalog: Readonly<Record<string, ScreenEntry>>,
): LintConfig {
  return { tag: screenTag, catalog };
}

const auction = configFor(screenCatalog);

export function inspectCall(
  method: string,
  payload: unknown,
): ScreenViolation[] {
  return inspectWith(auction, method, payload);
}
