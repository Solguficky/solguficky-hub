import { InlineKeyboard } from "grammy";
import type { AccessRight } from "../../../../auction-ui/index.js";
import type { BotCommand } from "../../../../core/menu-commands.js";
import { botCommands, managerCommands } from "../commands.js";
import {
  bullet,
  escapeHtml,
  nextRow,
  type Parent,
  screenText,
  toManage,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Корни разделов, которые открывают команды: «Настройки», «Помощь» и
// «Управление» с его группами. Корневого экрана «Меню» нет — между разделами
// человек ходит командами кнопки меню клиента (решение владельца 10 октября
// 2026 года). Подпись кнопки раздела совпадает с заголовком экрана, который она
// открывает.

// Бот показывает и пропускает пункты по праву, которое проверит сервис
// (RFC-016): вход, который ведёт в отказ, хуже его отсутствия. Круг и набор
// пунктов не решают. Сходки, скрытые сходки, объявление и аукцион у сходки с
// каталогом лотов — праву вести сходки; очередь сообщества, состав и каналы —
// праву управлять составом; очередь аукциона — праву допускать к торгам;
// администраторы — праву назначать администраторов (PER-521).
type Viewer = { rights: readonly AccessRight[] };

export function canManageMeetups(person: Viewer): boolean {
  return person.rights.includes("manage-meetups");
}

export function canManageMembers(person: Viewer): boolean {
  return person.rights.includes("manage-members");
}

export function canAdmitBidders(person: Viewer): boolean {
  return person.rights.includes("admit-bidders");
}

/**
 * Назначать и снимать администраторов: у мейнтейнера это право есть и без
 * набора admin, и «Управление» тогда показывает ему один этот пункт.
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

/**
 * Группы «Управления» (решение владельца 10 октября 2026 года): вместо девяти
 * кнопок подряд — три группы. Подпись группы сходок не «Сходки», чтобы не
 * спорить с разделом «Сходки», а группы заявок не «Заявки», чтобы не спорить с
 * её же пунктом.
 */
export type ManageGroup = "meetups" | "applications" | "members";

const groups: Record<
  ManageGroup,
  { label: string; code: string; id: ManageGroupScreen }
> = {
  meetups: { label: "Сходки и объявления", code: "m", id: "manage-meetups" },
  applications: {
    label: "Заявки и отказы",
    code: "a",
    id: "manage-applications",
  },
  members: { label: "Участники", code: "p", id: "manage-members" },
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

// Пункты группы по правам: группа видна, если видим хоть один её пункт.
function groupItems(
  person: Viewer,
  group: ManageGroup,
  newMeetupToken: string,
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
    case "applications":
      return [
        ...(canManageMembers(person)
          ? ([["Заявки", "v1:cm:q"]] satisfies Item[])
          : []),
        ...(canAdmitBidders(person)
          ? ([["Заявки в аукцион", "v1:aq:q"]] satisfies Item[])
          : []),
        ...(canManageMembers(person)
          ? ([["Отказанные", "v1:cm:r"]] satisfies Item[])
          : []),
        ...(canAdmitBidders(person)
          ? ([["Отказанные в аукцион", "v1:aq:r"]] satisfies Item[])
          : []),
      ];
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
 * Родитель пункта управления: его группа, а если человек видит одну группу —
 * само «Управление», которое тогда сразу показывает её пункты.
 */
export function manageItemParent(person: Viewer, group: ManageGroup): Parent {
  return manageGroups(person).length === 1
    ? toManage
    : { name: groups[group].label, data: manageGroupData(group) };
}

function itemsKeyboard(items: readonly Item[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [label, data] of items) {
    nextRow(keyboard).text(label, data);
  }
  return keyboard;
}

/**
 * «Управление» — корень раздела: ряда возврата нет. Человек с одной группой
 * видит сразу её пункты, с несколькими — кнопки групп. Ключ создания рождается
 * при отрисовке и лежит в кнопке: два быстрых нажатия несут один ключ, а
 * перерисовка — новый. Заявки в аукцион лежат рядом с заявками в сообщество:
 * заявка гостя подана в бот аукциона, а не в конкретный аукцион (решение
 * владельца по PER-534, дополнение ADR-064 к пункту 12).
 */
export function manageScreen(
  person: Viewer,
  newMeetupToken: string,
): ShownScreen {
  const visible = manageGroups(person);
  const [only] = visible;
  const keyboard =
    visible.length === 1 && only !== undefined
      ? itemsKeyboard(groupItems(person, only, newMeetupToken))
      : itemsKeyboard(
          visible.map((group) => [groups[group].label, manageGroupData(group)]),
        );
  return {
    id: "manage",
    text: screenText("Управление"),
    keyboard,
    format: "HTML",
  };
}

/** Экран группы — ребёнок «Управления»: её пункты и возврат «‹ Управление». */
export function manageGroupScreen(
  person: Viewer,
  group: ManageGroup,
  newMeetupToken: string,
): ShownScreen {
  return {
    id: groups[group].id,
    text: screenText(groups[group].label),
    keyboard: withNav(
      itemsKeyboard(groupItems(person, group, newMeetupToken)),
      toManage,
    ),
    format: "HTML",
  };
}

/** «Настройки» — корень раздела; пока в нём один пункт — уведомления. */
export function settingsScreen(): ShownScreen {
  return {
    id: "settings",
    text: screenText("Настройки", "Что и когда бот тебе присылает."),
    keyboard: new InlineKeyboard().text("Уведомления", "v1:notify:global"),
    format: "HTML",
  };
}

/**
 * «Помощь» — корень раздела без кнопок: текст о боте и команды строками.
 * `welcome` — текст о боте, абзацы через пустую строку.
 */
export function helpScreen(person: Viewer, welcome: string): ShownScreen {
  return {
    id: "help",
    text: screenText(
      "Помощь",
      ...welcome.split("\n\n").map(escapeHtml),
      [
        "Команды — в кнопке меню рядом с полем ввода:",
        ...commandsFor(person).map((entry) =>
          bullet(`/${entry.command} — ${entry.description}`),
        ),
      ].join("\n"),
    ),
    keyboard: new InlineKeyboard(),
    format: "HTML",
  };
}
