import { InlineKeyboard } from "grammy";
import type {
  Administrator,
  AppointAdministratorResult,
} from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { removableUsernamePattern } from "../parse-callback.js";
import {
  bullet,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  screenText,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// «Администраторы» (PER-521, ADR-065): держатели наборов admin и maintainer,
// назначение по нику и снятие набора admin. Экран видит держатель права
// grant_admins; право на каждое действие решает Identity и отвечает отказом
// значением, который здесь становится текстом.

export const toAdministrators: Parent = {
  name: "Администраторы",
  data: "v1:ad:l",
};

/** «Назначить»: вопрос о нике. */
export const appointData = "v1:ad:n";
/** «Нет» под подтверждением назначения: ник жил в кнопке «Да», и он пропал. */
export const appointDeclinedData = "v1:ad:an";

export const appointPrompt =
  "Кого назначить администратором? Отправь ник с @ или без.";

/**
 * Ник из ответа: без пробелов по краям и без ведущих @; чужое — `undefined`.
 * Ник едет в «Да» подтверждения как есть, поэтому сверяется с тем же
 * выражением, что и разбор кнопки.
 */
export function appointUsername(text: string): string | undefined {
  const username = text.trim().replace(/^@+/, "").trim();
  return removableUsernamePattern.test(username) ? username : undefined;
}

// С ником — ником, без ника — Telegram id: кода заявки у держателя набора нет.
function administratorLabel(administrator: Administrator): string {
  return administrator.telegramUsername === undefined
    ? `id ${administrator.telegramUserId}`
    : `@${administrator.telegramUsername}`;
}

function presetsLabel(administrator: Administrator): string {
  return [
    administrator.maintainer ? "мейнтейнер" : undefined,
    administrator.admin ? "администратор" : undefined,
  ]
    .filter((mark): mark is string => mark !== undefined)
    .join(", ");
}

/**
 * Список держателей наборов. «Снять» — только у держателя admin: набор
 * maintainer из бота не выдаётся и не снимается (ADR-065).
 */
export function administratorsScreen(
  administrators: readonly Administrator[],
  viewerId: string,
  parent: Parent,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  for (const administrator of administrators) {
    if (!administrator.admin) continue;
    nextRow(keyboard).text(
      `Снять ${administratorLabel(administrator)}`,
      `v1:ad:dq:${uuidToToken(administrator.identityId)}`,
    );
  }
  nextRow(keyboard).text("Назначить", appointData);
  nextRow(keyboard).text("Обновить", toAdministrators.data);
  return {
    id: "administrators",
    text: screenText(
      "Администраторы",
      administrators.length === 0
        ? "Пока никого."
        : administrators
            .map((administrator) =>
              bullet(
                `${escapeHtml(administratorLabel(administrator))}${administrator.identityId === viewerId ? " (ты)" : ""} · ${presetsLabel(administrator)}`,
              ),
            )
            .join("\n"),
      "Администратор решает заявки, ведёт состав и сходки. Мейнтейнера из бота не назначить и не снять.",
    ),
    keyboard: withNav(keyboard, parent),
    format: "HTML",
  };
}

/** Подтверждение назначения: ник едет в «Да», «Нет» — исход с «Ввести заново». */
export function appointConfirmScreen(username: string): ShownScreen {
  return {
    id: "administrator-appoint-confirm",
    text: screenText(
      "Назначить администратором?",
      `«@${escapeHtml(username)}»`,
      "Человек сможет решать заявки, вести состав и сходки, и ему придёт сообщение о назначении.",
    ),
    keyboard: confirmKeyboard({
      yes: "Да, назначить",
      yesData: `v1:ad:ay:${username}`,
      noData: appointDeclinedData,
    }),
    format: "HTML",
  };
}

/** Подтверждение снятия; снять можно и себя. «Нет» возвращает в список. */
export function dismissConfirmScreen(
  administrator: Administrator,
  viewerId: string,
): ShownScreen {
  return {
    id: "administrator-dismiss-confirm",
    text: screenText(
      "Снять администратора?",
      `«${escapeHtml(administratorLabel(administrator))}»`,
      administrator.identityId === viewerId
        ? "Это ты: права администратора уйдут у тебя. Записи останутся, назначить снова можно по нику."
        : "Права администратора уйдут: заявки, состав и сходки. Записи человека останутся, назначить снова можно по нику.",
    ),
    keyboard: confirmKeyboard({
      yes: "Да, снять",
      yesData: `v1:ad:dy:${uuidToToken(administrator.identityId)}`,
      noData: toAdministrators.data,
    }),
    format: "HTML",
  };
}

/** Исход без продолжения: только возврат в список. */
export function administratorOutcomeScreen(
  outcome: string,
  subject?: string,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(outcome, subject),
    keyboard: withNav(new InlineKeyboard(), toAdministrators),
    format: "HTML",
  };
}

/** Исход над присланным ником: над возвратом — «Ввести заново». */
export function appointRetryScreen(
  outcome: string,
  subject?: string,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(outcome, subject),
    keyboard: withNav(
      new InlineKeyboard().text("Ввести заново", appointData),
      toAdministrators,
    ),
    format: "HTML",
  };
}

/**
 * Текст исхода назначения. `forbidden` и `unavailable` сюда не входят: у них
 * свои кадры отказа и сбоя.
 */
export function appointOutcome(
  result: Exclude<
    AppointAdministratorResult,
    { kind: "forbidden" } | { kind: "unavailable" }
  >,
): { text: string; retry: boolean } {
  switch (result.kind) {
    case "ok":
      return result.value.changed
        ? {
            text: "Администратор назначен. Человеку придёт сообщение о назначении.",
            retry: false,
          }
        : { text: "Уже администратор. Ничего не изменилось.", retry: false };
    case "username-unknown":
      return {
        text: "Человек ещё не писал боту. Назначить можно того, у кого есть профиль: пусть он сначала напишет боту.",
        retry: true,
      };
    case "not-member":
      return {
        text: "Не участник сообщества. Администратором назначают только участника.",
        retry: true,
      };
    case "blocked":
      return {
        text: "Профиль заблокирован. Администратором его не назначить.",
        retry: true,
      };
    case "username-unresolved":
      return {
        text: "Ник не определяет человека. Этот ник сейчас у нескольких профилей: попроси человека написать боту и попробуй снова.",
        retry: true,
      };
    case "invalid":
      return {
        text: "Это не ник Telegram. Ник присылают с @ или без.",
        retry: true,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
