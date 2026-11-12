import {
  auctionChronicleButtonLabel,
  dayChronicleButtonLabel,
} from "../src/auction-day-chronicle.js";
import { hallScreenLabel, hallStreamLabel } from "../src/auction-hall.js";
import { predictionButtonLabel } from "../src/auction-prediction.js";
import { promoButtonLabel } from "../src/auction-promo.js";
import { raffleButtonLabel } from "../src/auction-raffle.js";
import { auctionResultsButtonLabel } from "../src/auction-results.js";
import {
  followLabel,
  lotNextLabel,
  lotPrevLabel,
  lotsLabel,
  unfollowLabel,
} from "../src/auction-standing.js";
import { invoicesButtonLabel } from "../src/auction-winner-invoices.js";
import {
  adminLabel,
  admitLabel,
  declineLabel,
  extensionsLabel,
  marked,
  pictogram,
  refreshLabel,
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

// Пары карточки лота у обоих ботов (PER-594, PER-644, PER-669): ряды
// складываются по смыслу — ставки, которые человек задаёт сам, и взгляд на
// лот: «Ставки» с отметкой избранного. Листание лотов — ряд
// `[◀️][🔄 Обновить][▶️]`; на краях ленты и у лота с итогом он короче.
const lotCardPairs = [
  "Своя сумма|Автоставка",
  `Ставки|${followLabel}`,
  `Ставки|${unfollowLabel}`,
  `${lotPrevLabel}|${refreshLabel}|${lotNextLabel}`,
  `${lotPrevLabel}|${refreshLabel}`,
  `${refreshLabel}|${lotNextLabel}`,
];

// Корень аукциона у обоих ботов (решение владельца по прогону stage 27.10,
// PER-798; пересматривает №66 прогона 14.10): «Лоты» — своим рядом, а
// бесплатные поводы — розыгрыш и прогнозы или, без прогнозов, их итоги —
// одним рядом. «Хроники дня» и «Статистика» (PER-770) — торги аукциона за
// сутки и за всё время, одна группа.
const auctionRootPairs = [
  // «🏷️ Лоты» и «🎬 Промо» — первым рядом (PER-798).
  `${lotsLabel}|${promoButtonLabel}`,
  `${raffleButtonLabel}|${predictionButtonLabel}`,
  `${raffleButtonLabel}|${auctionResultsButtonLabel}`,
  `${dayChronicleButtonLabel}|${auctionChronicleButtonLabel}`,
  // «Итоги» и «Мои счета» завершённого аукциона — одним рядом (PER-832).
  `${auctionResultsButtonLabel}|${invoicesButtonLabel}`,
  // «Стрим финала ↗» и «Экран финала ↗» — ссылки одним рядом (PER-832).
  `${hallStreamLabel}|${hallScreenLabel}`,
];

// Пары хаба, названные поимённо. «Отписаться» рядом с «Уведомлениями сходки» —
// пара, которой в дизайн-коде нет: подписка живёт в карточке по решению
// PER-402, и отдельным рядом она вывела бы карточку за пять рядов. Материалы
// и расширения сходки — её содержимое одним рядом (PER-307, PER-605): у
// организатора ряд расширений иначе стал бы шестым. «#» — число материалов в
// подписи.
// Решение по заявке — бинарная пара выбора одним рядом (решение владельца
// 10 октября 2026 года). Фильтры состава (PER-547) — участники с гостями и
// модераторы с соседним списком ников; «• » отмечает выбранный фильтр.
const hubNamedPairs: ReadonlySet<string> = new Set([
  `${admitLabel}|${declineLabel}`,
  "• Участники|Гости",
  "Участники|• Гости",
  "Участники|Гости",
  "• Модераторы|Разрешённые ники",
  "Модераторы|Разрешённые ники",
  // Подписи карточки несут знаки своих разделов (PER-644).
  `${adminLabel("Изменить")}|${adminLabel("Статус")}`,
  `${marked(pictogram.off, "Отписаться")}|${marked(pictogram.settings, "Уведомления сходки")}`,
  `${marked(pictogram.materials, "Материалы (#)")}|${extensionsLabel}`,
  // Корень аукциона (PER-605): свои отметки и правила — парой, как стояли в
  // корне ленты (PER-500). «🛠 Пульт» ряд с «Розыгрышем» больше не делит
  // (PER-669).
  "Избранное|Правила и FAQ",
  // Способ шага лота (PER-491): бинарная пара выбора одним рядом.
  "Один шаг|По порогам",
  // Правка лота сета (PER-716): один лот или весь сет — бинарная пара выбора
  // одним рядом; «#» — число лотов сета.
  "Только этот лот|Все лоты сета (#)",
  // Группы пульта (PER-802): пара — только одна группа. «Торги» — окна и
  // сводка дня, «Участникам» — объявление и промо-видео, лента — сеты и
  // порядок, неделя — сроки с финалом и окна со сроком оплаты.
  "Счастливые часы|Сводка дня",
  "Объявление|Промо-видео",
  "Сеты|Порядок",
  "Сроки недели|Вкл · Финал в зале",
  "Сроки недели|Выкл · Финал в зале",
  "Срок оплаты|Текст оплаты",
  // Раздел ленты (PER-719): перестановка раздела и его правка — бинарные
  // пары одним рядом, иначе полная страница лотов вышла бы за потолок рядов.
  "Раздел выше|Раздел ниже",
  `Переименовать|${marked(pictogram.remove, "Удалить раздел")}`,
  // Ориентировочное время финала (PER-663): анонс и его снятие — одна группа
  // одним рядом: два «🗑» в ряд не встают.
  "Время финала|🗑 Убрать время финала",
  // «Розыгрыш» пульта (PER-802): момент и его снятие, приз и его снятие,
  // смена приза идущего розыгрыша и его фото (PER-737, PER-773).
  "Момент розыгрыша|🗑 Убрать розыгрыш",
  "Приз|🗑 Убрать приз",
  "Изменить приз|🗑 Убрать приз",
  "Изменить приз|Фото приза",
  // Поля «Изменить лот» по два в ряд (прогон 12.10, №17): шесть рядов
  // столбиком выводили экран за высоту телефона.
  `${marked(pictogram.title, "Название")}|${marked(pictogram.description, "Описание")}`,
  `${marked(pictogram.photo, "Фото")}|${marked(pictogram.price, "Цена и шаг")}`,
  ...lotCardPairs,
  ...auctionRootPairs,
]);

type Catalog = Readonly<Record<string, ScreenEntry>>;

// Поверхность с деревом экранов. У бота поддержки экранов нет — у человека
// переписка, у операторов тема (ADR-068; дизайн-код, «Бот поддержки»), — и
// каталога ему не положено.
export type ScreenSurface = Exclude<Surface, "support">;

const configFor: Record<ScreenSurface, (catalog: Catalog) => LintConfig> = {
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
  // Именованные пары у дерева аукциона — пары карточки лота и корня аукциона,
  // группа родителей одна — списки аукционов, в которые возвращает лента.
  auction: (catalog) => ({
    tag: auctionTag,
    catalog,
    parentGroups: { [auctionListParent]: auctionLists },
    namedPairs: new Set([...lotCardPairs, ...auctionRootPairs]),
  }),
};

const configs: Record<ScreenSurface, LintConfig> = {
  hub: configFor.hub(hubCatalog),
  auction: configFor.auction(auctionCatalog),
};

/** Каталог передаётся только в тестах каталогов и линтера; в работе он один. */
export function inspectCall(
  surface: ScreenSurface,
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
  surface: ScreenSurface,
  catalog?: Catalog,
): ScreenViolation[] {
  return inspectGraphWith(
    catalog === undefined ? configs[surface] : configFor[surface](catalog),
  );
}
