import { InlineKeyboard } from "grammy";
import type { AccessRight } from "../../../../auction-ui/index.js";
import { escapeHtml, nextRow, screenText, toMenu, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Корень дерева и вход в управление. Подпись кнопки раздела совпадает с
// заголовком экрана, который она открывает.

// Пункты Meetups — создание сходки, скрытые сходки, объявление — решает роль
// администратора: так их проверяют Meetups и Identity, и вход, который ведёт в
// отказ, хуже его отсутствия.
export function isAdministrator(person: {
  globalRoles: readonly string[];
}): boolean {
  return person.globalRoles.includes("admin");
}

// Состав и очереди бот показывает по праву, а не по роли (ADR-064, пункт 6):
// очередь сообщества и состав — праву управлять составом, очередь аукциона —
// праву модерировать аукцион. Решает всё равно Identity.
type Viewer = {
  globalRoles: readonly string[];
  rights: readonly AccessRight[];
};

export function canManageMembership(person: Viewer): boolean {
  return person.rights.includes("manage-membership");
}

export function canModerateAuction(person: Viewer): boolean {
  return person.rights.includes("moderate-auction");
}

/** «Управление» видно, если в нём есть хотя бы один пункт для человека. */
export function canOpenManagement(person: Viewer): boolean {
  return (
    isAdministrator(person) ||
    canManageMembership(person) ||
    canModerateAuction(person)
  );
}

/** Меню — корень дерева: ряда возврата у него нет. `welcome` — текст о боте. */
export function menuScreen(person: Viewer, welcome: string): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text("Ближайшие сходки", "v1:nav:hub")
    .text("Архив", "v1:nav:archive")
    .row()
    .text("Уведомления", "v1:notify:global");
  if (canOpenManagement(person)) {
    keyboard.row().text("Управление", "v1:manage:menu");
  }
  return {
    id: "menu",
    text: screenText("Меню", escapeHtml(welcome)),
    keyboard,
    format: "HTML",
  };
}

/**
 * Управление: пункты по правам человека. Ключ создания рождается при отрисовке
 * и лежит в кнопке: два быстрых нажатия несут один ключ, а перерисовка меню —
 * новый. Заявки в аукцион лежат рядом с заявками в сообщество: заявка гостя
 * подана в бот аукциона, а не в конкретный аукцион (решение владельца по
 * PER-534, дополнение ADR-064 к пункту 12).
 */
export function manageScreen(
  person: Viewer,
  newMeetupToken: string,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  const item = (label: string, data: string) => {
    nextRow(keyboard).text(label, data);
  };
  if (isAdministrator(person)) {
    item("Создать сходку", `v1:manage:new:${newMeetupToken}`);
    item("Скрытые сходки", "v1:manage:hidden");
  }
  if (canManageMembership(person)) {
    item("Заявки", "v1:cm:q");
  }
  if (canModerateAuction(person)) {
    item("Заявки в аукцион", "v1:aq:q");
  }
  if (canManageMembership(person)) {
    item("Состав сообщества", "v1:community:list");
    item("Отказанные", "v1:cm:r");
  }
  if (canModerateAuction(person)) {
    item("Отказанные в аукцион", "v1:aq:r");
  }
  if (canManageMembership(person)) {
    item("Каналы прихода", "v1:sc:l");
  }
  if (isAdministrator(person)) {
    item("Объявление сообществу", "v1:bc:c");
  }
  return {
    id: "manage",
    text: screenText("Управление"),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}
