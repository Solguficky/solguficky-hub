import { InlineKeyboard } from "grammy";
import type { NotificationCategoryView } from "../../application/types.js";
import type { MeetupSnapshot } from "../../meetups/port.js";
import type {
  CategoryState,
  NotificationCategory,
} from "../../notifications/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  escapeHtml,
  screenText,
  toCard,
  toggleLabel,
  toMenu,
  withNav,
} from "./kit.js";
import { meetupTitleLabel } from "./meetup.js";
import type { ShownScreen } from "./show.js";

// Ярлыки повторяют строки макета P-07 дословно: экран настроек обязан называть
// категории теми же словами, что и продуктовая таблица, иначе «изменения»
// придётся сопоставлять по догадке.
export const categoryLabels: Record<NotificationCategory, string> = {
  published: "Новые сходки",
  changes: "Изменения данных и статуса",
  material: "Новые материалы",
  reminder: "Напоминание перед началом",
  organizer: "Сообщения организатора",
  announcement: "Объявления сообщества",
};

// Новые сходки и объявления сообществу не привязаны ни к какой сходке, и
// подписаться на них нельзя: они приходят всем, кто их не выключил.
function withoutSubscription(category: NotificationCategory): boolean {
  return category === "published" || category === "announcement";
}

/**
 * Кадр P-08: подтверждение переключателя всплывающим текстом. Экран после
 * нажатия показывает только новое состояние; что сработало именно это
 * нажатие, говорит ответ на него.
 */
export function toggleToast(
  category: NotificationCategory,
  enabled: boolean,
): string {
  return `${enabled ? "Включено" : "Выключено"}: ${categoryLabels[category].toLowerCase()}.`;
}

export function globalNotificationsScreen(
  categories: readonly CategoryState<NotificationCategory>[],
): ShownScreen {
  // Подзаголовков у клавиатуры нет, поэтому группы называет текст, а кнопки
  // идут в том же порядке: сначала то, что приходит без подписки.
  const ordered = [
    ...categories.filter((entry) => withoutSubscription(entry.category)),
    ...categories.filter((entry) => !withoutSubscription(entry.category)),
  ];
  const keyboard = new InlineKeyboard();
  for (const entry of ordered) {
    keyboard
      .text(
        toggleLabel(categoryLabels[entry.category], entry.enabled),
        `v1:notify:gset:${entry.category}:${entry.enabled ? "0" : "1"}`,
      )
      .row();
  }
  return {
    id: "notify-global",
    text: screenText(
      "Уведомления",
      "Приходят всем, без подписки: новые сходки и объявления сообщества.",
      "По сходкам, на которые ты подписан: изменения, новые материалы, напоминание и сообщения организатора. Здесь — значение для всех таких сходок, включая будущие. У отдельной сходки его можно поменять в её уведомлениях, и тогда общая настройка её уже не меняет.",
      "Нажми на категорию, чтобы включить или выключить её.",
    ),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}

export function meetupNotificationsScreen(settings: {
  meetup: MeetupSnapshot;
  subscribed: boolean;
  categories: readonly NotificationCategoryView[];
}): ShownScreen {
  const token = uuidToToken(settings.meetup.id);
  const keyboard = new InlineKeyboard();
  for (const entry of settings.categories) {
    keyboard
      .text(
        toggleLabel(categoryLabels[entry.category], entry.enabled),
        `v1:notify:set:${token}:${entry.category}:${entry.enabled ? "0" : "1"}`,
      )
      .row();
  }
  // Что значение расходится с общей настройкой, говорит текст, а не подпись
  // кнопки: подпись несёт только состояние.
  const differing = settings.categories
    .filter((entry) => entry.differsFromGlobal)
    .map((entry) => categoryLabels[entry.category].toLowerCase());
  return {
    id: "notify-meetup",
    text: screenText(
      "Уведомления сходки",
      `«${escapeHtml(meetupTitleLabel(settings.meetup.title))}»`,
      // Подписки здесь нет намеренно: действие живёт в карточке P-04. Состояние
      // подписки кадр называет текстом, чтобы состояния категорий не читались
      // как «придёт всё это».
      settings.subscribed
        ? "Ты следишь за этой сходкой."
        : "Ты за этой сходкой не следишь: придут только те уведомления, которым подписка не нужна. Подписаться можно из карточки.",
      // Следствие принятого контракта, названное человеку до нажатия, а не
      // после: операции снятия переопределения на проводе нет, и вернуть
      // «как везде» изнутри кадра будет уже нельзя.
      "Нажми на категорию, чтобы включить или выключить её. Настройка действует только для этой сходки и закрепляется за ней: общая настройка её больше не меняет.",
      differing.length === 0
        ? undefined
        : `Отличаются от общих: ${differing.join(", ")}. Общие настройки — в меню, раздел «Уведомления».`,
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}
