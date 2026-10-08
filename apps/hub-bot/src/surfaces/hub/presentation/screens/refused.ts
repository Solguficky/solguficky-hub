import { InlineKeyboard } from "grammy";
import type { CommunityDay } from "../../community-time.js";
import type { RefusedApplication } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  pagedTitle,
  paginate,
  readableMoment,
  screenText,
  toManage,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Список отказанных и пересмотр (ADR-060, пункт 14). Подпись исхода различает
// блокировку и `declined`: от неё зависит, что сделает пересмотр.

const circleLabel: Record<RefusedApplication["circle"], string> = {
  member: "в хаб",
  public: "в аукцион",
};

const outcomeLabel: Record<RefusedApplication["outcome"], string> = {
  blocked: "заблокирован",
  declined: "отклонена",
};

const refusedData = (page: number) => `v1:cm:r:${page}`;

// Ник, а без ника — ссылка на профиль по Telegram id: имени у отказанной
// заявки нет, его обнулило решение.
function personLabel(person: {
  telegramUsername?: string;
  telegramUserId: bigint;
}): string {
  return person.telegramUsername === undefined
    ? `id ${person.telegramUserId}`
    : `@${person.telegramUsername}`;
}

function personHtml(person: {
  telegramUsername?: string;
  telegramUserId: bigint;
}): string {
  return person.telegramUsername === undefined
    ? `<a href="tg://user?id=${person.telegramUserId}">без ника</a>`
    : escapeHtml(personLabel(person));
}

function refusedLine(
  application: RefusedApplication,
  today: CommunityDay,
): string {
  const who =
    application.decidedBy === undefined
      ? ""
      : `${personHtml(application.decidedBy)}, `;
  return [
    `• ${personHtml(application)} — заявка ${circleLabel[application.circle]}, ${outcomeLabel[application.outcome]}`,
    `  ${who}${escapeHtml(readableMoment(application.decidedAt, today))}`,
  ].join("\n");
}

export function refusedScreen(
  applications: readonly RefusedApplication[],
  requestedPage: number,
  today: CommunityDay,
): ShownScreen {
  const page = paginate(applications, requestedPage);
  const keyboard = new InlineKeyboard();
  for (const application of page.items) {
    nextRow(keyboard).text(
      // Круг в подписи: у человека бывает по отказу в каждый из двух кругов.
      buttonText(
        `Пересмотреть ${personLabel(application)} ${circleLabel[application.circle]}`,
      ),
      `v1:cm:rq:${uuidToToken(application.applicationId)}:${page.page}`,
    );
  }
  withPager(keyboard, page, refusedData);
  return {
    id: "refused",
    text: screenText(
      pagedTitle("Отказанные", page),
      page.items.length === 0
        ? "Пока никого."
        : page.items
            .map((application) => refusedLine(application, today))
            .join("\n"),
    ),
    keyboard: withNav(keyboard, toManage),
    format: "HTML",
  };
}

/**
 * Подтверждение пересмотра называет последствие: у блокировки — её снятие и
 * выдачу роли, у `declined` — допуск по закрытой заявке.
 */
export function reconsiderConfirmScreen(
  application: RefusedApplication,
  page: number,
): ShownScreen {
  const person = personHtml(application);
  const access =
    application.circle === "member"
      ? "откроется доступ к сходкам сообщества"
      : "откроется доступ к аукциону";
  const consequence =
    application.outcome === "blocked"
      ? `Блокировка ${person} снимется, и сразу ${access}.`
      : `Заявка ${person} ${circleLabel[application.circle]} будет принята: ${access}.`;
  return {
    id: "reconsider-confirm",
    text: screenText("Пересмотреть отказ?", consequence),
    keyboard: confirmKeyboard({
      yes: "Да, пересмотреть",
      yesData: `v1:cm:ry:${uuidToToken(application.applicationId)}:${page}`,
      noData: refusedData(page),
    }),
    format: "HTML",
  };
}
