import { InlineKeyboard } from "grammy";
import { refreshLabel } from "../../../../core/pictograms.js";
import { applicationCode } from "../../application/hub-access.js";
import type {
  CommunityCircle,
  CommunityFilter,
  CommunityMember,
  CommunityMemberResult,
  CommunitySnapshot,
} from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  type CommunityPlace,
  communityPlaceData,
  firstMembersPage,
  removableUsernamePattern,
} from "../parse-callback.js";
import { toAdministrators } from "./administrators.js";
import {
  bullet,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  type Parent,
  pagedTitle,
  paginate,
  removeLabel,
  screenText,
  toCommunity,
  toManage,
  withNav,
  withPager,
} from "./kit.js";
import { canGrantAdmins } from "./menu.js";
import type { ShownScreen } from "./show.js";

/** Какой из экранов состава показать. */
export type CommunityView =
  | { kind: "list"; place: CommunityPlace }
  | { kind: "usernames"; page: number };

/** Первая страница участников — куда ведёт пункт «Состав сообщества». */
export const firstCommunityPlace: CommunityPlace = firstMembersPage;

export function communityListData(place: CommunityPlace): string {
  return `v1:cm:l:${communityPlaceData(place)}`;
}

/** Возврат к месту списка, с которого открыта карточка. */
export function toCommunityPlace(place: CommunityPlace): Parent {
  return { name: toCommunity.name, data: communityListData(place) };
}

function memberData(
  verb: "v" | "mg" | "mv" | "bq" | "by",
  member: CommunityMember,
  place: CommunityPlace,
): string {
  return `v1:cm:${verb}:${uuidToToken(member.identityId)}:${communityPlaceData(place)}`;
}

// Человек без ника называется кодом заявки: тот же код он видит в кадре
// ожидания и называет администратору, а кнопка несёт то же представление.
export function memberLabel(member: CommunityMember): string {
  return member.telegramUsername === undefined
    ? `без ника · ${applicationCode(member.identityId)}`
    : `@${member.telegramUsername}`;
}

// В тексте без ника — ещё и упоминание по Telegram id: по нему администратор
// открывает профиль и узнаёт человека, а не только код.
function memberHtml(member: CommunityMember): string {
  return member.telegramUsername === undefined &&
    member.telegramUserId !== undefined
    ? `<a href="tg://user?id=${member.telegramUserId}">без ника</a> · ${escapeHtml(applicationCode(member.identityId))}`
    : escapeHtml(memberLabel(member));
}

const filterLabels: Readonly<Record<CommunityFilter, string>> = {
  members: "Участники",
  guests: "Гости",
  moderators: "Модераторы",
};

const filterTitles: Readonly<Record<CommunityFilter, string>> = {
  ...filterLabels,
  moderators: "Модераторы аукциона",
};

const emptyTexts: Readonly<Record<CommunityFilter, string>> = {
  members: "Участников пока нет.",
  guests: "Гостей пока нет.",
  moderators: "Модераторов аукциона пока нет.",
};

const circleWords: Readonly<Record<CommunityCircle, string>> = {
  member: "участник",
  guest: "гость",
  none: "без круга",
};

// Фильтр сужает список и на сервере, но старый Identity его не знает и
// отдаёт всех: бот сужает ещё раз сам, и люди без круга не попадают никуда.
function inFilter(member: CommunityMember, filter: CommunityFilter): boolean {
  switch (filter) {
    case "members":
      return member.circle === "member";
    case "guests":
      return member.circle === "guest";
    case "moderators":
      return member.circle !== "none" && member.auctionModeration;
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

/** Подпись фильтра: у выбранного — отметка «• », как у выбора частоты. */
function filterLabel(filter: CommunityFilter, current: CommunityFilter) {
  return filter === current
    ? `• ${filterLabels[filter]}`
    : filterLabels[filter];
}

/** Обстановка экрана состава, которую знает только вызывающий. */
export type CommunityScreenOptions = {
  // Исход последнего действия над разрешёнными никами.
  notice?: string | undefined;
  // Родитель — группа пункта либо само «Управление» (`manageItemParent`).
  parent?: Parent;
  // Кто смотрит: его строка списка помечена «(ты)», как у администраторов.
  viewerId?: string;
};

export function communityScreen(
  snapshot: CommunitySnapshot,
  view: CommunityView,
  { notice, parent = toManage, viewerId }: CommunityScreenOptions = {},
): ShownScreen {
  switch (view.kind) {
    case "list":
      return listScreen(snapshot, view.place, parent, viewerId);
    case "usernames":
      return usernamesScreen(snapshot, view.page, notice);
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

// Строка человека в тексте списка: смотрящий помечен «(ты)», модерация —
// только под фильтром участников: под фильтром модераторов её видно и так.
function memberLine(
  member: CommunityMember,
  filter: CommunityFilter,
  viewerId: string | undefined,
): string {
  const self = member.identityId === viewerId ? " (ты)" : "";
  const moderation =
    filter === "members" && member.auctionModeration
      ? " · модерирует аукцион"
      : "";
  return bullet(`${memberHtml(member)}${self}${moderation}`);
}

/**
 * Список людей состава с фильтром по кругу (PER-547): участники и гости
 * парой, под ними модераторы аукциона парой с разрешёнными никами — соседние
 * списки состава. Список полный (PER-618): держатели наборов в нём в своём
 * круге и в счётчике, но Identity не отдаёт признака набора, поэтому пометки
 * «администратор» у строки нет — что это администратор, отвечает его
 * карточка. Человек открывает карточку. «Обновить» нет: восемь человек,
 * листание и два ряда списков занимают все двенадцать рядов, а выбранный
 * фильтр перечитывает список нажатием.
 */
function listScreen(
  snapshot: CommunitySnapshot,
  place: CommunityPlace,
  parent: Parent,
  viewerId: string | undefined,
): ShownScreen {
  const people = snapshot.members.filter((member) =>
    inFilter(member, place.filter),
  );
  const page = paginate(people, place.page);
  const shown: CommunityPlace = { filter: place.filter, page: page.page };
  const keyboard = new InlineKeyboard()
    .text(
      filterLabel("members", place.filter),
      communityListData(firstCommunityPlace),
    )
    .text(
      filterLabel("guests", place.filter),
      communityListData({ filter: "guests", page: 0 }),
    )
    .row()
    .text(
      filterLabel("moderators", place.filter),
      communityListData({ filter: "moderators", page: 0 }),
    )
    .text("Разрешённые ники", "v1:cm:u");
  for (const member of page.items) {
    nextRow(keyboard).text(memberLabel(member), memberData("v", member, shown));
  }
  withPager(keyboard, page, (target) =>
    communityListData({ filter: place.filter, page: target }),
  );
  return {
    id: "community",
    text: screenText(
      pagedTitle("Состав сообщества", page),
      `${filterTitles[place.filter]}: ${people.length}`,
      page.items.length === 0
        ? emptyTexts[place.filter]
        : page.items
            .map((member) => memberLine(member, place.filter, viewerId))
            .join("\n"),
    ),
    keyboard: withNav(keyboard, parent),
    format: "HTML",
  };
}

/**
 * Карточка человека (PER-547): круг и модерация аукциона. Модерацию выдают
 * только участнику (ADR-065, п. 4): у гостя её кнопки нет. Кнопки видит
 * держатель права управлять составом — без него экран не открывается.
 * Карточку перечитывает каждое действие с неё, «Обновить» ей не нужно.
 */
export function communityMemberScreen(
  member: CommunityMember,
  place: CommunityPlace,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (member.circle === "member") {
    keyboard.text(
      member.auctionModeration ? "Снять модерацию" : "Выдать модерацию",
      memberData(member.auctionModeration ? "mv" : "mg", member, place),
    );
  }
  nextRow(keyboard).text("Закрыть доступ", memberData("bq", member, place));
  return {
    id: "community-member",
    text: screenText(
      "Карточка человека",
      memberHtml(member),
      [
        `Круг: ${circleWords[member.circle]}`,
        member.circle === "member"
          ? `Модерация аукциона: ${member.auctionModeration ? "есть" : "нет"}`
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    ),
    keyboard: withNav(keyboard, toCommunityPlace(place)),
    format: "HTML",
  };
}

/** Отказ Identity на карточке — текстом экрана (PER-547). */
export function communityMemberRefusalText(
  result: Exclude<CommunityMemberResult, { kind: "ok" }>,
  forbidden: string,
  unavailable: string,
): string {
  switch (result.kind) {
    case "forbidden":
      return forbidden;
    case "identity-unknown":
      return "Такого человека нет в составе.";
    case "blocked":
      return "Доступ этому человеку уже закрыт.";
    case "holds-preset":
      return "Это администратор: закрыть доступ или поменять модерацию отсюда нельзя. Правами администратора управляет мейнтейнер в «Участники → Администраторы».";
    default:
      return unavailable;
  }
}

/**
 * Кнопки под отказом карточки: возврат на то же место списка, а у
 * администратора — ещё «Администраторы» тому, кто их ведёт (PER-618).
 */
export function communityMemberRefusalKeyboard(
  result: Exclude<CommunityMemberResult, { kind: "ok" }>,
  place: CommunityPlace,
  viewer: Parameters<typeof canGrantAdmins>[0],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (result.kind === "holds-preset" && canGrantAdmins(viewer)) {
    keyboard.text(toAdministrators.name, toAdministrators.data);
  }
  return withNav(keyboard, toCommunityPlace(place));
}

function usernamesScreen(
  snapshot: CommunitySnapshot,
  requestedPage: number,
  notice: string | undefined,
): ShownScreen {
  const page = paginate(snapshot.allowedUsernames, requestedPage);
  const keyboard = new InlineKeyboard();
  // Кнопка рисуется только для ника, который доедет обратно в `callback_data`:
  // более длинный вышиб бы весь экран отказом Telegram на 64 байта, а разбор
  // всё равно назвал бы его сломанным.
  for (const username of page.items) {
    if (!removableUsernamePattern.test(username)) continue;
    nextRow(keyboard).text(
      removeLabel(`Убрать @${username}`),
      `v1:cm:rm:${page.page}:${username}`,
    );
  }
  nextRow(keyboard).text("Добавить ник", "v1:community:allow");
  withPager(keyboard, page, (target) => `v1:cm:u:${target}`);
  nextRow(keyboard).text(refreshLabel, `v1:cm:u:${page.page}`);
  return {
    id: "community-usernames",
    text: screenText(
      pagedTitle("Разрешённые ники", page),
      notice === undefined ? undefined : escapeHtml(notice),
      page.items.length === 0
        ? "Пока ни одного."
        : page.items
            .map((username) => `• ${escapeHtml(`@${username}`)}`)
            .join("\n"),
    ),
    keyboard: withNav(keyboard, toCommunity),
    format: "HTML",
  };
}

/**
 * Подтверждение закрытия доступа. Закрытый человек из списков уходит, и
 * вернуть его из бота нельзя: это говорит текст, а не цвет (PER-473). «Нет»
 * возвращает на карточку.
 */
export function closeAccessConfirmScreen(
  member: CommunityMember,
  place: CommunityPlace,
): ShownScreen {
  return {
    id: "community-close-confirm",
    text: screenText(
      "Закрыть доступ?",
      `${memberHtml(member)} перестанет видеть сходки сообщества. Вернуть доступ из бота нельзя.`,
    ),
    keyboard: confirmKeyboard({
      yes: "Да, закрыть доступ",
      yesData: memberData("by", member, place),
      noData: memberData("v", member, place),
      irreversible: true,
    }),
    format: "HTML",
  };
}
