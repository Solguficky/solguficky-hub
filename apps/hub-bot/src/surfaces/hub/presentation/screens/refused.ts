import { InlineKeyboard } from "grammy";
import type { ApplicationQueue } from "../../../../auction-ui/index.js";
import type { CommunityDay } from "../../community-time.js";
import type { RefusedApplication } from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { queueDomain } from "../parse-callback.js";
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
// блокировку и `declined`: от неё зависит, что сделает пересмотр. Список —
// одной очереди (ADR-064, пункт 15), и домен кнопок называет её.

const circleLabel: Record<RefusedApplication["circle"], string> = {
  member: "в хаб",
  public: "в аукцион",
};

const outcomeLabel: Record<RefusedApplication["outcome"], string> = {
  blocked: "заблокирован",
  declined: "отклонена",
};

const refusedData = (queue: ApplicationQueue) => (page: number) =>
  `${queueDomain(queue)}:r:${page}`;

/** Заголовок списка: «Отказанные» — в сообщество, «Отказанные в аукцион». */
export function refusedTitle(queue: ApplicationQueue): string {
  return queue === "community" ? "Отказанные" : "Отказанные в аукцион";
}

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

/**
 * `liftsBlocks` — человек может снять блокировку: пересмотр отказа `blocked`
 * Identity пускает по праву управлять составом. Модератору аукциона без него
 * кнопка у такого отказа не рисуется: она вела бы в отказ.
 */
export function refusedScreen(
  queue: ApplicationQueue,
  applications: readonly RefusedApplication[],
  requestedPage: number,
  today: CommunityDay,
  liftsBlocks = true,
): ShownScreen {
  const page = paginate(applications, requestedPage);
  const keyboard = new InlineKeyboard();
  for (const application of page.items) {
    if (application.outcome === "blocked" && !liftsBlocks) continue;
    nextRow(keyboard).text(
      // Круг в подписи: у человека бывает по отказу в каждый из двух кругов.
      buttonText(
        `Пересмотреть ${personLabel(application)} ${circleLabel[application.circle]}`,
      ),
      `${queueDomain(queue)}:rq:${uuidToToken(application.applicationId)}:${page.page}`,
    );
  }
  withPager(keyboard, page, refusedData(queue));
  return {
    id: queue === "community" ? "refused" : "refused-auction",
    text: screenText(
      pagedTitle(refusedTitle(queue), page),
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
  queue: ApplicationQueue,
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
      yesData: `${queueDomain(queue)}:ry:${uuidToToken(application.applicationId)}:${page}`,
      noData: refusedData(queue)(page),
      style: "success",
    }),
    format: "HTML",
  };
}
