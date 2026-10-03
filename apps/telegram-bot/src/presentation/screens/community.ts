import { InlineKeyboard } from "grammy";
import { applicationCode } from "../../application/hub-access.js";
import type {
  CommunityMember,
  CommunitySnapshot,
} from "../../identity/port.js";
import { tokenToUuid, uuidToToken } from "../meetup-deep-link.js";
import {
  type BlockOrigin,
  blockOriginData,
  removableUsernamePattern,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  nextRow,
  pagedTitle,
  paginate,
  screenText,
  toCommunity,
  toManage,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

const refreshLabel = "Обновить";

/** Какой из экранов состава показать. */
export type CommunityView =
  | { kind: "root" }
  /** Курсор — идентификатор человека, а не номер: очередь меняется. */
  | { kind: "pending"; cursor?: string }
  | { kind: "admitted"; page: number }
  | { kind: "usernames"; page: number };

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

function pendingOf(snapshot: CommunitySnapshot): readonly CommunityMember[] {
  return snapshot.members.filter((member) => !member.admitted);
}

function admittedOf(snapshot: CommunitySnapshot): readonly CommunityMember[] {
  return snapshot.members.filter((member) => member.admitted);
}

export function communityScreen(
  snapshot: CommunitySnapshot,
  view: CommunityView,
  notice?: string,
): ShownScreen {
  switch (view.kind) {
    case "root":
      return rootScreen(snapshot);
    case "pending":
      return pendingScreen(snapshot, view.cursor);
    case "admitted":
      return admittedScreen(snapshot, view.page);
    case "usernames":
      return usernamesScreen(snapshot, view.page, notice);
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

function rootScreen(snapshot: CommunitySnapshot): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text("Ожидают допуска", "v1:cm:p")
    .row()
    .text("Допущенные", "v1:cm:a")
    .row()
    .text("Разрешённые ники", "v1:cm:u")
    .row()
    .text(refreshLabel, toCommunity.data);
  return {
    id: "community",
    text: screenText(
      "Состав сообщества",
      [
        `Ожидают допуска: ${pendingOf(snapshot).length}`,
        `Допущены: ${admittedOf(snapshot).length}`,
        `Разрешённые ники: ${snapshot.allowedUsernames.length}`,
      ].join("\n"),
    ),
    keyboard: withNav(keyboard, toManage),
    format: "HTML",
  };
}

/**
 * Модерация по одному. Человека под курсором уже могли допустить или закрыть
 * с другого экрана: тогда показывается первый в очереди, а не пустота.
 */
function pendingScreen(
  snapshot: CommunitySnapshot,
  cursor: string | undefined,
): ShownScreen {
  const queue = pendingOf(snapshot);
  const at = Math.max(
    0,
    queue.findIndex((member) => member.identityId === cursor),
  );
  const member = queue[at];
  if (member === undefined) {
    return {
      id: "community-pending",
      text: screenText("Ожидают допуска", "Очередь пуста."),
      keyboard: withNav(new InlineKeyboard(), toCommunity),
      format: "HTML",
    };
  }
  const token = uuidToToken(member.identityId);
  // Следующий — по кругу: «Пропустить» с последнего возвращает к первому, и
  // пропущенный человек не теряется. У очереди из одного следующего нет.
  const next = queue.length > 1 ? queue[(at + 1) % queue.length] : undefined;
  const nextToken =
    next === undefined ? undefined : uuidToToken(next.identityId);
  const origin: BlockOrigin = {
    kind: "pending",
    ...(nextToken === undefined ? {} : { next: nextToken }),
  };
  const keyboard = new InlineKeyboard()
    .text(
      "Допустить",
      nextToken === undefined
        ? `v1:cm:ad:${token}`
        : `v1:cm:ad:${token}:${nextToken}`,
    )
    .row()
    .text("Закрыть", `v1:cm:bq:${token}:${blockOriginData(origin)}`);
  if (nextToken !== undefined) {
    keyboard.row().text("Пропустить", `v1:cm:p:${nextToken}`);
  }
  keyboard.row().text(refreshLabel, `v1:cm:p:${token}`);
  return {
    id: "community-pending",
    text: screenText(
      "Ожидают допуска",
      memberHtml(member),
      `В очереди: ${queue.length}`,
    ),
    keyboard: withNav(keyboard, toCommunity),
    format: "HTML",
  };
}

function admittedScreen(
  snapshot: CommunitySnapshot,
  requestedPage: number,
): ShownScreen {
  const page = paginate(admittedOf(snapshot), requestedPage);
  const keyboard = new InlineKeyboard();
  for (const member of page.items) {
    nextRow(keyboard).text(
      `Закрыть ${memberLabel(member)}`,
      `v1:cm:bq:${uuidToToken(member.identityId)}:${blockOriginData({ kind: "admitted", page: page.page })}`,
    );
  }
  withPager(keyboard, page, (target) => `v1:cm:a:${target}`);
  nextRow(keyboard).text(refreshLabel, `v1:cm:a:${page.page}`);
  return {
    id: "community-admitted",
    text: screenText(
      pagedTitle("Допущенные", page),
      page.items.length === 0
        ? "Пока никого."
        : page.items.map((member) => `• ${memberHtml(member)}`).join("\n"),
    ),
    keyboard: withNav(keyboard, toCommunity),
    format: "HTML",
  };
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
      `Убрать @${username}`,
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

/** Экран, на который возвращает закрытие доступа: откуда оно начато. */
export function viewOfOrigin(origin: BlockOrigin): CommunityView {
  if (origin.kind === "admitted") {
    return { kind: "admitted", page: origin.page };
  }
  return origin.next === undefined
    ? { kind: "pending" }
    : { kind: "pending", cursor: tokenToUuid(origin.next) };
}

/**
 * Подтверждение закрытия доступа. Закрытый человек из списков уходит, и
 * вернуть его из бота нельзя, поэтому «Да» красится `danger`.
 */
export function closeAccessConfirmScreen(
  member: CommunityMember,
  origin: BlockOrigin,
): ShownScreen {
  const token = uuidToToken(member.identityId);
  // «Нет» возвращает к тому же человеку в очереди или на ту же страницу.
  const noData =
    origin.kind === "pending" ? `v1:cm:p:${token}` : `v1:cm:a:${origin.page}`;
  return {
    id: "community-close-confirm",
    text: screenText(
      "Закрыть доступ?",
      `${memberHtml(member)} перестанет видеть сходки сообщества. Вернуть доступ из бота нельзя.`,
    ),
    keyboard: confirmKeyboard({
      yes: "Да, закрыть доступ",
      yesData: `v1:cm:by:${token}:${blockOriginData(origin)}`,
      noData,
      danger: true,
    }),
    format: "HTML",
  };
}
