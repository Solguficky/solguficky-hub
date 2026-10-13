import {
  admitLabel,
  declineLabel,
  extensionsLabel,
} from "../src/core/pictograms.js";
import type { Surface } from "../src/core/surface.js";
import {
  screenCatalog as auctionCatalog,
  auctionListParent,
  auctionLists,
  screenTag as auctionTag,
} from "../src/surfaces/auction/screen-catalog.js";
import {
  auctionRootParent,
  auctionRootParents,
  screenCatalog as hubCatalog,
  manageParents,
  meetupListParent,
  meetupLists,
} from "../src/surfaces/hub/presentation/screens/catalog.js";
import { screenTag as hubTag } from "../src/surfaces/hub/presentation/screens/show.js";
import {
  inspectCatalog as inspectGraphWith,
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

// Пары карточки лота у обоих ботов (PER-594): ряды складываются по смыслу —
// ставки, которые человек задаёт сам, и просмотр хода торгов.
const lotCardPairs = ["Своя сумма|Автоставка", "Обновить|Ставки"];

// Пары хаба, названные поимённо. «Отписаться» рядом с «Уведомлениями сходки» —
// пара, которой в дизайн-коде нет: подписка живёт в карточке по решению
// PER-402, и отдельным рядом она вывела бы карточку за пять рядов. Материалы
// и расширения сходки — её содержимое одним рядом (PER-307, PER-605): у
// организатора ряд расширений иначе стал бы шестым. «#» — число материалов в
// подписи.
// Решение по заявке и очередь допуска — бинарные пары выбора одним рядом
// (решение владельца 10 октября 2026 года).
const hubNamedPairs: ReadonlySet<string> = new Set([
  `${admitLabel}|${declineLabel}`,
  `${admitLabel}|Закрыть`,
  "Изменить|Статус",
  "Отписаться|Уведомления сходки",
  `Материалы (#)|${extensionsLabel}`,
  // Корень аукциона (PER-605): входы администратора и розыгрыша, затем свои
  // отметки и правила — парами, как стояли в корне ленты (PER-500).
  "Пульт|Розыгрыш",
  "Избранное|Правила и FAQ",
  ...lotCardPairs,
]);

type Catalog = Readonly<Record<string, ScreenEntry>>;

const configFor: Record<Surface, (catalog: Catalog) => LintConfig> = {
  hub: (catalog) => ({
    tag: hubTag,
    catalog,
    // Карточка возвращает в тот список, в котором сходка стоит; корень
    // аукциона — в «Расширения» его сходки, а если бот её не знает, в
    // «Сходки»; пункт управления — в свою группу либо, у человека с одной
    // группой, в «Управление».
    parentGroups: {
      [meetupListParent]: meetupLists,
      [auctionRootParent]: auctionRootParents,
      ...manageParents,
    },
    namedPairs: hubNamedPairs,
  }),
  // Именованные пары у дерева аукциона — только пары карточки лота, группа
  // родителей одна — списки аукционов, в которые возвращает лента.
  auction: (catalog) => ({
    tag: auctionTag,
    catalog,
    parentGroups: { [auctionListParent]: auctionLists },
    namedPairs: new Set(lotCardPairs),
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

/**
 * Граф дерева экранов поверхности по каталогу (PER-592): один корень — меню,
 * у каждого экрана дерева цепочка родителей доходит до него. Каталог
 * передаётся только в тестах самого правила.
 */
export function inspectCatalog(
  surface: Surface,
  catalog?: Catalog,
): ScreenViolation[] {
  return inspectGraphWith(
    catalog === undefined ? configs[surface] : configFor[surface](catalog),
  );
}
