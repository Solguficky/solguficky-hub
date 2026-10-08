import {
  auctionFeedParent,
  auctionFeedParents,
  meetupListParent,
  meetupLists,
  screenCatalog,
} from "../src/surfaces/hub/presentation/screens/catalog.js";
import { screenTag } from "../src/surfaces/hub/presentation/screens/show.js";
import {
  inspectCall as inspectWith,
  type LintConfig,
  type ScreenEntry,
  type ScreenViolation,
  type UnknownEntryKeys,
} from "./lint/index.js";

// Линтер экрана хаба: общий линтер дизайн-кода (`shared/typescript/screen-lint`)
// с каталогом и частными правилами дерева хаба. Его зовёт записывающий
// трансформер харнесса, поэтому правило проверяется в каждом тесте L0 и L2,
// который вообще что-то отправил, а не в отдельном наборе.

export {
  reportViolations,
  type ScreenEntry,
  type ScreenViolation,
  takeViolations,
} from "./lint/index.js";

// Каталог объявлен без `satisfies` — сборка бота не видит пакета линтера, — и
// опечатку в необязательном поле записи ловит этот тип при typecheck.
const catalogShape: [UnknownEntryKeys<typeof screenCatalog>] extends [never]
  ? true
  : never = true;
void catalogShape;

// Пары, названные поимённо. «Отписаться» рядом с «Уведомлениями сходки» —
// пара, которой в дизайн-коде нет: подписка живёт в карточке по решению
// PER-402, и отдельным рядом она вывела бы карточку за пять рядов. Материалы
// и аукцион сходки — содержимое сходки одним рядом (PER-307): у организатора
// ряд аукциона иначе стал бы шестым. «#» — число материалов в подписи.
const namedPairs: ReadonlySet<string> = new Set([
  "Изменить|Статус",
  "Отписаться|Уведомления сходки",
  "Материалы (#)|Лоты",
  "Материалы (#)|Включить аукцион",
]);

function configFor(catalog: Readonly<Record<string, ScreenEntry>>): LintConfig {
  return {
    tag: screenTag,
    catalog,
    // Карточка возвращает в тот список, в котором сходка стоит; лента лотов —
    // к сходке аукциона, а если бот её не знает, в «Ближайшие».
    parentGroups: {
      [meetupListParent]: meetupLists,
      [auctionFeedParent]: auctionFeedParents,
    },
    namedPairs,
  };
}

const hub = configFor(screenCatalog);

/** Каталог передаётся только в тестах самого линтера; в работе он один. */
export function inspectCall(
  method: string,
  payload: unknown,
  catalog?: Readonly<Record<string, ScreenEntry>>,
): ScreenViolation[] {
  return inspectWith(
    catalog === undefined ? hub : configFor(catalog),
    method,
    payload,
  );
}
