import type { Surface } from "../src/core/surface.js";
import {
  screenCatalog as auctionCatalog,
  auctionListParent,
  auctionLists,
  screenTag as auctionTag,
} from "../src/surfaces/auction/screen-catalog.js";
import {
  auctionFeedParent,
  auctionFeedParents,
  screenCatalog as hubCatalog,
  meetupListParent,
  meetupLists,
} from "../src/surfaces/hub/presentation/screens/catalog.js";
import { screenTag as hubTag } from "../src/surfaces/hub/presentation/screens/show.js";
import {
  inspectCall as inspectWith,
  type LintConfig,
  type ScreenEntry,
  type ScreenViolation,
  type UnknownEntryKeys,
} from "./lint/index.js";

// Линтер экрана обеих поверхностей: линтер дизайн-кода (`lint/`) с каталогом и
// частными правилами дерева поверхности. Его зовёт записывающий трансформер
// харнесса, поэтому правило проверяется в каждом тесте L0 и L2, который
// вообще что-то отправил, а не в отдельном наборе. Найденное у обеих
// поверхностей копится в одном накопителе и снимается `lint-setup.ts`.

export {
  reportViolations,
  type ScreenEntry,
  type ScreenViolation,
  takeViolations,
} from "./lint/index.js";

// Каталоги объявлены без `satisfies` — сборка бота не видит линтера, — и
// опечатку в необязательном поле записи ловят эти типы при typecheck.
const hubShape: [UnknownEntryKeys<typeof hubCatalog>] extends [never]
  ? true
  : never = true;
const auctionShape: [UnknownEntryKeys<typeof auctionCatalog>] extends [never]
  ? true
  : never = true;
void hubShape;
void auctionShape;

// Пары хаба, названные поимённо. «Отписаться» рядом с «Уведомлениями сходки» —
// пара, которой в дизайн-коде нет: подписка живёт в карточке по решению
// PER-402, и отдельным рядом она вывела бы карточку за пять рядов. Материалы
// и аукцион сходки — содержимое сходки одним рядом (PER-307): у организатора
// ряд аукциона иначе стал бы шестым. «#» — число материалов в подписи.
const hubNamedPairs: ReadonlySet<string> = new Set([
  "Изменить|Статус",
  "Отписаться|Уведомления сходки",
  "Материалы (#)|Лоты",
  "Материалы (#)|Включить аукцион",
  "Пульт|Правила и FAQ",
]);

type Catalog = Readonly<Record<string, ScreenEntry>>;

const configFor: Record<Surface, (catalog: Catalog) => LintConfig> = {
  hub: (catalog) => ({
    tag: hubTag,
    catalog,
    // Карточка возвращает в тот список, в котором сходка стоит; лента лотов —
    // к сходке аукциона, а если бот её не знает, в «Ближайшие».
    parentGroups: {
      [meetupListParent]: meetupLists,
      [auctionFeedParent]: auctionFeedParents,
    },
    namedPairs: hubNamedPairs,
  }),
  // Именованных пар у дерева аукциона нет, группа родителей одна — списки
  // аукционов, в которые возвращает лента.
  auction: (catalog) => ({
    tag: auctionTag,
    catalog,
    parentGroups: { [auctionListParent]: auctionLists },
  }),
};

const configs: Record<Surface, LintConfig> = {
  hub: configFor.hub(hubCatalog),
  auction: configFor.auction(auctionCatalog),
};

/** Каталог передаётся только в тестах каталогов и линтера; в работе он один. */
export function inspectCall(
  surface: Surface,
  method: string,
  payload: unknown,
  catalog?: Catalog,
): ScreenViolation[] {
  return inspectWith(
    catalog === undefined ? configs[surface] : configFor[surface](catalog),
    method,
    payload,
  );
}
