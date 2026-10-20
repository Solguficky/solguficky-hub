import { InlineKeyboard } from "grammy";
import {
  type AuctionNotificationChange,
  type AuctionNotificationSettings,
  auctionNotificationsExplanation,
  auctionNotificationsRows,
} from "../../../../core/notifications/outbid.js";
import type { NotificationCategoryView } from "../../application/types.js";
import type { MeetupSnapshot } from "../../meetups/port.js";
import type {
  CategoryState,
  NotificationCategory,
} from "../../notifications/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { toSettingsAuction } from "./extensions.js";
import {
  notificationToggleLabel,
  screenText,
  subjectLine,
  toCard,
  toSettings,
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
  "access-community": "Запросы доступа в сообщество",
  "access-auction": "Запросы доступа в аукцион",
  release: "Новое в боте",
};

// Заявки разведены по очереди: у каждой своя подпись и свой выключатель, и
// кнопка под оповещением выключает только свою очередь (PER-635).
export const accessRequestCategories: readonly NotificationCategory[] = [
  "access-community",
  "access-auction",
];

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
  // идут в том же порядке: сначала то, что приходит без подписки, потом
  // запросы доступа, потом категории сходок. Запросы доступа бот не
  // показывает и не прячет сам: их нет в снимке у того, кто не решает заявки
  // этой очереди.
  const access = categories.filter((entry) =>
    accessRequestCategories.includes(entry.category),
  );
  const release = categories.filter((entry) => entry.category === "release");
  const ordered = [
    ...categories.filter((entry) => withoutSubscription(entry.category)),
    ...access,
    ...categories.filter(
      (entry) =>
        !withoutSubscription(entry.category) &&
        !accessRequestCategories.includes(entry.category) &&
        entry.category !== "release",
    ),
    ...release,
  ];
  const keyboard = new InlineKeyboard();
  for (const entry of ordered) {
    keyboard
      .text(
        notificationToggleLabel(categoryLabels[entry.category], entry.enabled),
        `v1:notify:gset:${entry.category}:${entry.enabled ? "0" : "1"}`,
      )
      .row();
  }
  return {
    id: "notify-global",
    text: screenText(
      "Уведомления",
      "Приходят всем, без подписки: новые сходки и объявления сообщества.",
      access.length === 0
        ? undefined
        : access.length === 1
          ? "Только тому, кто решает заявки этой очереди."
          : "Только тому, кто решает заявки: у каждой очереди своя настройка, и выключение одной не гасит другую.",
      "По сходкам, на которые ты подписан: изменения, новые материалы, напоминание и сообщения организатора. Здесь — значение для всех таких сходок, включая будущие. У отдельной сходки его можно поменять в её уведомлениях, и тогда общая настройка её уже не меняет.",
      "Нажми на категорию, чтобы включить или выключить её.",
    ),
    keyboard: withNav(keyboard, toSettings),
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
        notificationToggleLabel(categoryLabels[entry.category], entry.enabled),
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
      subjectLine(meetupTitleLabel(settings.meetup.title)),
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
        : `Отличаются от общих: ${differing.join(", ")}. Общие настройки — в «Настройках» (/settings), раздел «Уведомления».`,
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

/**
 * Данные кнопки настройки уведомлений аукциона: целевое значение, а не шаг.
 * Данные частоты прежние, поэтому старые кнопки режима, «Реже» и «Частота
 * уведомлений» из старых сообщений ставят свой режим и открывают экран.
 */
export function auctionNotificationsChangeData(
  change: AuctionNotificationChange,
): string {
  switch (change.kind) {
    case "frequency":
      return `v1:notify:outbid:${change.frequency}`;
    case "final":
      return `v1:notify:final:${change.enabled ? "1" : "0"}`;
    case "live":
      return `v1:notify:live:${change.enabled ? "1" : "0"}`;
  }
}

/**
 * Настройки уведомлений аукциона (PER-552, PER-539, PER-645) —
 * самодостаточные, как у бота аукциона: каждая настройка — одна кнопка с
 * текущим значением, нажатие ведёт к следующему (решение владельца по прогону
 * 14 октября 2026 года, №72; дизайн-код, «Уведомления»). Выбор отменяется с
 * того же экрана, поэтому подтверждения «Да» нет: что сработало, говорит
 * ответ на нажатие. Это «Уведомления» расширения «Аукцион» в «Настройках» →
 * «Расширения» (№74): в «Уведомлениях» настроек остаются только категории
 * ядра (PER-605).
 */
export function auctionNotificationsScreen(
  current: AuctionNotificationSettings,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  for (const row of auctionNotificationsRows(current)) {
    keyboard.text(row.text, auctionNotificationsChangeData(row.change)).row();
  }
  return {
    id: "notify-outbid",
    text: screenText("Уведомления", ...auctionNotificationsExplanation),
    keyboard: withNav(keyboard, toSettingsAuction),
    format: "HTML",
  };
}
