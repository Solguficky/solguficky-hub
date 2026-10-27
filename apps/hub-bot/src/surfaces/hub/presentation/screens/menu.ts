import { InlineKeyboard } from "grammy";
import type {
  AccessRight,
  ApplicationQueue,
} from "../../../../auction-ui/index.js";
import type { BuildInfo } from "../../../../core/build-info.js";
import {
  menuTitle,
  supportBotLink,
  supportLabel,
} from "../../../../core/entry.js";
import type { BotCommand } from "../../../../core/menu-commands.js";
import { adminLabel, extensionsLabel } from "../../../../core/pictograms.js";
import type { CommunityDay } from "../../community-time.js";
import { botCommands, managerCommands } from "../commands.js";
import { eventLines, type HubEvent } from "./events.js";
import { settingsExtensionsData } from "./extensions.js";
import {
  bullet,
  escapeHtml,
  nextRow,
  type Parent,
  screenText,
  toEvents,
  toManage,
  toMeetups,
  toMenu,
  toSettings,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Корневое меню и разделы, которые открывают команды: «Настройки», «Помощь»
// и «Управление» с его группами. Меню — общий родитель разделов: команды
// открывают раздел сразу, а «‹ Меню» с раздела ведёт в него (PER-592;
// пересматривает решение владельца 10 октября 2026 года). Подпись кнопки
// раздела совпадает с заголовком экрана, который она открывает.

// Бот показывает и пропускает пункты по праву, которое проверит сервис
// (RFC-016): вход, который ведёт в отказ, хуже его отсутствия. Круг и набор
// пунктов не решают. Сходки, скрытые сходки и объявление — праву вести
// сходки; очередь сообщества, состав и каналы — праву управлять составом;
// очередь аукциона — праву допускать к торгам; администраторы — праву
// назначать администраторов (PER-521). Аукцион у сходки, его пульт, пульт
// ведущего и каталог лотов — праву вести аукцион (ADR-070, PER-654): они живут
// в корне аукциона сходки, а не в «Управлении», и одно это право «Управления»
// и `/manage` не открывает.
type Viewer = { rights: readonly AccessRight[] };

export function canManageMeetups(person: Viewer): boolean {
  return person.rights.includes("manage-meetups");
}

export function canRunAuctions(person: Viewer): boolean {
  return person.rights.includes("run-auctions");
}

export function canManageMembers(person: Viewer): boolean {
  return person.rights.includes("manage-members");
}

export function canAdmitBidders(person: Viewer): boolean {
  return person.rights.includes("admit-bidders");
}

/**
 * Назначать и снимать администраторов: у мейнтейнера это право есть и без
 * набора admin, и «Управление» тогда показывает ему одну группу «Участники».
 */
export function canGrantAdmins(person: Viewer): boolean {
  return person.rights.includes("grant-admins");
}

/** «Управление» видно, если в нём есть хотя бы один пункт для человека. */
export function canOpenManagement(person: Viewer): boolean {
  return manageGroups(person).length > 0;
}

/** Команды кнопки меню клиента этого человека: `/manage` — праву управления. */
export function commandsFor(person: Viewer): readonly BotCommand[] {
  return canOpenManagement(person) ? managerCommands : botCommands;
}

/** Идущие события для меню: время сообщества и сами события (PER-669). */
export type MenuEvents = {
  events: readonly HubEvent[];
  timeZone: string;
  today: CommunityDay;
};

/**
 * Корневое меню (PER-669; решение владельца по отзыву тестовой группы
 * 19 октября 2026 года): `[Сходки][Ближайшая сходка]`, `[События]` — пока
 * идёт хотя бы одно событие, `[Настройки][Помощь]` и «🛠 Управление» своим
 * рядом держателю права управления. Без событий — ни кнопки, ни строки о них:
 * бот не шумит. Те же разделы — команды кнопки меню клиента. Возврата у
 * корня нет.
 */
export function menuScreen(person: Viewer, current?: MenuEvents): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text("Сходки", toMeetups.data)
    .text("Ближайшая сходка", "v1:nav:next");
  const events = current?.events ?? [];
  if (events.length > 0) nextRow(keyboard).text(toEvents.name, toEvents.data);
  nextRow(keyboard).text("Настройки", toSettings.data).text("Помощь", helpData);
  if (canOpenManagement(person)) {
    nextRow(keyboard).text(adminLabel("Управление"), toManage.data);
  }
  const lines =
    current === undefined
      ? []
      : eventLines(events, current.timeZone, current.today);
  return {
    id: "menu",
    text: screenText(
      menuTitle,
      "Разделы бота. Те же разделы — в кнопке меню рядом с полем ввода.",
      lines.length === 0
        ? undefined
        : ["Идут события:", ...lines.map(escapeHtml)].join("\n"),
    ),
    keyboard,
    format: "HTML",
  };
}

const helpData = "v1:nav:help";

/**
 * Группы «Управления» (решение владельца 10 октября 2026 года): вместо девяти
 * кнопок подряд — три группы. Подпись группы сходок не «Сходки», чтобы не
 * спорить с разделом «Сходки», а группы заявок не «Заявки», чтобы не спорить с
 * её же пунктом.
 */
export type ManageGroup = "meetups" | "applications" | "members";

// Пояснение под заголовком группы (PER-633, прогон 14.10 №104): заголовок
// без абзаца сжимает пузырь, и подписи кнопок не влезают.
const groups: Record<
  ManageGroup,
  { label: string; code: string; id: ManageGroupScreen; lead: string }
> = {
  meetups: {
    label: "Сходки и объявления",
    code: "m",
    id: "manage-meetups",
    lead: "Новые сходки, черновики и объявления всему сообществу.",
  },
  applications: {
    label: "Заявки и отказы",
    code: "a",
    id: "manage-applications",
    lead: "Очереди заявок и тех, кому отказано.",
  },
  members: {
    label: "Участники",
    code: "p",
    id: "manage-members",
    lead: "Кто в сообществе и с какими правами.",
  },
};

type ManageGroupScreen =
  | "manage-meetups"
  | "manage-applications"
  | "manage-members";

const groupOrder: readonly ManageGroup[] = [
  "meetups",
  "applications",
  "members",
];

/** Данные кнопки группы: `v1:manage:g:<код>`. */
export function manageGroupData(group: ManageGroup): string {
  return `v1:manage:g:${groups[group].code}`;
}

/** Группа по коду кнопки; чужой код — `undefined`. */
export function manageGroupOf(code: string): ManageGroup | undefined {
  return groupOrder.find((group) => groups[group].code === code);
}

type Item = [label: string, data: string];

/**
 * Числа на кнопках очередей заявок (PER-636): сколько заявок ждёт и сколько
 * отказано по каждой очереди. Читает их `bot.ts` существующими вызовами
 * Identity и передаёт экрану; отказ одного чтения оставляет поле пустым, и его
 * кнопка идёт без числа.
 */
export type ApplicationCounts = {
  queue?: Readonly<Partial<Record<ApplicationQueue, number>>>;
  refused?: Readonly<Partial<Record<ApplicationQueue, number>>>;
};

// Подпись кнопки с числом: «Заявки (2)». Числа нет — подпись без него.
function item(label: string, data: string, count?: number): Item {
  return [count === undefined ? label : `${label} (${count})`, data];
}

// Пункты группы по правам: группа видна, если видим хоть один её пункт.
// `counts` приходят только экрану группы заявок; на видимость группы они не
// влияют, поэтому проверка графа зовёт `groupItems` без них.
function groupItems(
  person: Viewer,
  group: ManageGroup,
  newMeetupToken: string,
  counts?: ApplicationCounts,
): Item[] {
  switch (group) {
    case "meetups":
      return canManageMeetups(person)
        ? [
            ["Создать сходку", `v1:manage:new:${newMeetupToken}`],
            ["Скрытые сходки", "v1:manage:hidden"],
            ["Объявление сообществу", "v1:bc:c"],
          ]
        : [];
    case "applications": {
      const queue = counts?.queue;
      const refused = counts?.refused;
      return [
        ...(canManageMembers(person)
          ? ([item("Заявки", "v1:cm:q", queue?.community)] satisfies Item[])
          : []),
        ...(canAdmitBidders(person)
          ? ([
              item("Заявки в аукцион", "v1:aq:q", queue?.auction),
            ] satisfies Item[])
          : []),
        ...(canManageMembers(person)
          ? ([
              item("Отказанные", "v1:cm:r", refused?.community),
            ] satisfies Item[])
          : []),
        ...(canAdmitBidders(person)
          ? ([
              item("Отказанные в аукцион", "v1:aq:r", refused?.auction),
            ] satisfies Item[])
          : []),
      ];
    }
    case "members":
      return [
        ...(canManageMembers(person)
          ? ([
              ["Состав сообщества", "v1:community:list"],
              ["Каналы прихода", "v1:sc:l"],
            ] satisfies Item[])
          : []),
        ...(canGrantAdmins(person)
          ? ([["Администраторы", "v1:ad:l"]] satisfies Item[])
          : []),
      ];
    default: {
      const _exhaustive: never = group;
      return _exhaustive;
    }
  }
}

/** Группы, которые человек видит, в порядке экрана. */
export function manageGroups(person: Viewer): ManageGroup[] {
  // Ключ создания на видимость не влияет.
  return groupOrder.filter((group) => groupItems(person, group, "").length > 0);
}

/**
 * Родитель пункта управления — всегда его группа: место пункта не зависит от
 * того, сколько групп человек видит (решение владельца по прогону 14.10, №49).
 */
export function manageItemParent(group: ManageGroup): Parent {
  return { name: groups[group].label, data: manageGroupData(group) };
}

function itemsKeyboard(items: readonly Item[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [label, data] of items) {
    nextRow(keyboard).text(label, data);
  }
  return keyboard;
}

/**
 * «Управление» — раздел под корневым меню: кнопки видимых групп и возврат
 * «‹ Меню». Одна видимая группа тоже идёт кнопкой: раскрытие одной группы
 * прямо в «Управлении» убрано (решение владельца по прогону 14.10, №49).
 * Заявки в аукцион лежат рядом с заявками в сообщество: заявка гостя подана в
 * бот аукциона, а не в конкретный аукцион (решение владельца по PER-534,
 * дополнение ADR-064 к пункту 12).
 */
export function manageScreen(person: Viewer): ShownScreen {
  const keyboard = itemsKeyboard(
    manageGroups(person).map((group) => [
      groups[group].label,
      manageGroupData(group),
    ]),
  );
  return {
    id: "manage",
    keyboard: withNav(keyboard, toMenu),
    text: screenText(
      "Управление",
      "Сходки, заявки и участники сообщества — по группам.",
    ),
    format: "HTML",
  };
}

/**
 * Экран группы — ребёнок «Управления»: её пункты и возврат «‹ Управление».
 * Ключ создания сходки рождается при отрисовке и лежит в кнопке: два быстрых
 * нажатия несут один ключ, а перерисовка — новый.
 */
export function manageGroupScreen(
  person: Viewer,
  group: ManageGroup,
  newMeetupToken: string,
  counts?: ApplicationCounts,
): ShownScreen {
  return {
    id: groups[group].id,
    text: screenText(groups[group].label, groups[group].lead),
    keyboard: withNav(
      itemsKeyboard(groupItems(person, group, newMeetupToken, counts)),
      toManage,
    ),
    format: "HTML",
  };
}

/**
 * «Настройки» — раздел под меню: уведомления ядра и «Расширения» — настройки
 * расширений сходок, у аукциона это частота «перебили» (PER-605; ADR-064,
 * дополнение 2026-10-12).
 */
export function settingsScreen(): ShownScreen {
  return {
    id: "settings",
    text: screenText(
      "Настройки",
      "Что и когда бот тебе присылает, и настройки расширений сходок.",
    ),
    keyboard: withNav(
      new InlineKeyboard()
        .text("Уведомления", "v1:notify:global")
        .row()
        .text(extensionsLabel, settingsExtensionsData),
      toMenu,
    ),
    format: "HTML",
  };
}

// Правила расширений живут в их корне: «Помощь» ядра их не повторяет и только
// говорит, где расширения сходки (ADR-064, дополнение 2026-10-12).
const extensionsHelp = `Расширения сходки, например аукцион, — кнопка «${extensionsLabel}» в её карточке.`;

/**
 * Строка версии образа (PER-736): короткий коммит и дата его коммита из данных
 * сборки, без них — «локальная сборка».
 */
export function versionLine(build: BuildInfo): string {
  if (build.kind === "local") return "Версия бота: локальная сборка.";
  const [year, month, day] = build.date.split("-");
  return `Версия бота: ${build.commit} от ${day}.${month}.${year}.`;
}

/**
 * «Помощь» — раздел под меню: текст о боте и команды строками. Под текстом
 * «Что нового», при адресе бота поддержки — «Написать в поддержку ↗»
 * (PER-625), последним рядом «‹ Меню». `welcome` — текст о боте, абзацы через
 * пустую строку. Строку версии видит только мейнтейнер (решение владельца
 * 25 октября 2026 года, PER-736): его право `grant-admins` даёт один набор
 * `maintainer` (ADR-065, п. 3).
 */
export function helpScreen(
  person: Viewer,
  welcome: string,
  options: { build: BuildInfo; supportBotUsername?: string },
): ShownScreen {
  const { build, supportBotUsername } = options;
  const keyboard = new InlineKeyboard().text("Что нового", "v1:wn").row();
  if (supportBotUsername !== undefined) {
    keyboard.url(supportLabel, supportBotLink(supportBotUsername, "hub")).row();
  }
  return {
    id: "help",
    text: screenText(
      "Помощь",
      ...welcome.split("\n\n").map(escapeHtml),
      escapeHtml(extensionsHelp),
      [
        "Команды — в кнопке меню рядом с полем ввода:",
        ...commandsFor(person).map((entry) =>
          bullet(`/${entry.command} — ${entry.description}`),
        ),
      ].join("\n"),
      canGrantAdmins(person) ? escapeHtml(versionLine(build)) : undefined,
    ),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}
