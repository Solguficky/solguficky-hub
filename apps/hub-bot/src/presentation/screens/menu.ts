import { InlineKeyboard } from "grammy";
import { escapeHtml, screenText, toMenu, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Корень дерева и вход в управление. Подпись кнопки раздела совпадает с
// заголовком экрана, который она открывает.

// Управлять сходками и составом может только администратор: так решают Meetups
// и Identity, и вход, который ведёт в отказ, хуже его отсутствия.
export function isAdministrator(person: {
  globalRoles: readonly string[];
}): boolean {
  return person.globalRoles.includes("admin");
}

/** Меню — корень дерева: ряда возврата у него нет. `welcome` — текст о боте. */
export function menuScreen(
  person: { globalRoles: readonly string[] },
  welcome: string,
): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text("Ближайшие сходки", "v1:nav:hub")
    .text("Архив", "v1:nav:archive")
    .row()
    .text("Уведомления", "v1:notify:global");
  if (isAdministrator(person)) {
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
 * Управление сходками. Ключ создания рождается при отрисовке и лежит в кнопке:
 * два быстрых нажатия несут один ключ, а перерисовка меню — новый.
 */
export function manageScreen(
  person: { globalRoles: readonly string[] },
  newMeetupToken: string,
): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text("Создать сходку", `v1:manage:new:${newMeetupToken}`)
    .row()
    .text("Скрытые сходки", "v1:manage:hidden")
    .row()
    .text("Заявки", "v1:cm:q")
    .row()
    .text("Состав сообщества", "v1:community:list")
    .row()
    .text("Отказанные", "v1:cm:r")
    .row()
    .text("Каналы прихода", "v1:sc:l");
  // Объявление видит только администратор: сервис откажет остальным и так,
  // но вход, который ведёт в отказ после набора текста, хуже его отсутствия.
  if (isAdministrator(person)) {
    keyboard.row().text("Объявление сообществу", "v1:bc:c");
  }
  return {
    id: "manage",
    text: screenText("Управление"),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}
