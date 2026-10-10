import { InlineKeyboard } from "grammy";
import type { AccessRight } from "../../../../auction-ui/index.js";
import { escapeHtml, nextRow, screenText, toMenu, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Корень дерева и вход в управление. Подпись кнопки раздела совпадает с
// заголовком экрана, который она открывает.

// Бот показывает и пропускает пункты по праву, которое проверит сервис
// (RFC-016): вход, который ведёт в отказ, хуже его отсутствия. Круг и набор
// пунктов не решают. Сходки, скрытые сходки, объявление и аукцион у сходки с
// каталогом лотов — праву вести сходки; очередь сообщества, состав и каналы —
// праву управлять составом; очередь аукциона — праву допускать к торгам.
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

/** «Управление» видно, если в нём есть хотя бы один пункт для человека. */
export function canOpenManagement(person: Viewer): boolean {
  return (
    canManageMeetups(person) ||
    canManageMembers(person) ||
    canAdmitBidders(person)
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
  if (canManageMeetups(person)) {
    item("Создать сходку", `v1:manage:new:${newMeetupToken}`);
    item("Скрытые сходки", "v1:manage:hidden");
  }
  if (canManageMembers(person)) {
    item("Заявки", "v1:cm:q");
  }
  if (canAdmitBidders(person)) {
    item("Заявки в аукцион", "v1:aq:q");
  }
  if (canManageMembers(person)) {
    item("Состав сообщества", "v1:community:list");
    item("Отказанные", "v1:cm:r");
  }
  if (canAdmitBidders(person)) {
    item("Отказанные в аукцион", "v1:aq:r");
  }
  if (canManageMembers(person)) {
    item("Каналы прихода", "v1:sc:l");
  }
  if (canManageMeetups(person)) {
    item("Объявление сообществу", "v1:bc:c");
  }
  return {
    id: "manage",
    text: screenText("Управление"),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}
