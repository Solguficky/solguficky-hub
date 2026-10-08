import { InlineKeyboard } from "grammy";
import type { ApplicationQueue } from "../../../../auction-ui/index.js";
import { applicationCode } from "../../application/hub-access.js";
import type {
  ApplicationCard,
  ApplicationDecision,
} from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  type CardCursor,
  cardCursorData,
  queueDomain,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  screenText,
  toManage,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Карточка заявки «по одному» (ADR-060, пункты 21–22): одна заявка, её круг,
// источник и возраст. Курсор в кнопках — момент создания и токен заявки, порядок
// очереди держит Identity: от старых к новым. Очередей две (ADR-064, пункт 12),
// и домен кнопок называет очередь: курсор одной другую не ставит.

const circleLabel: Record<ApplicationCard["circle"], string> = {
  member: "хаб",
  public: "аукцион",
};

export function cursorOf(application: ApplicationCard): CardCursor {
  return {
    token: uuidToToken(application.applicationId),
    createdAtMs: application.createdAtMs,
  };
}

/** `…:qc:…` — та же карточка, пока заявка открыта. */
export function sameCardData(
  queue: ApplicationQueue,
  cursor: CardCursor,
): string {
  return `${queueDomain(queue)}:qc:${cardCursorData(cursor)}`;
}

/** Заголовок очереди: «Заявки» — в сообщество, «Заявки в аукцион». */
export function queueTitle(queue: ApplicationQueue): string {
  return queue === "community" ? "Заявки" : "Заявки в аукцион";
}

// Человек без ника назван именем и кодом — последними восемью символами
// идентификатора, как в очереди состава и в кадре ожидания (hub-bot.md).
function personHtml(application: ApplicationCard): string {
  const name =
    application.firstName === undefined
      ? undefined
      : escapeHtml(application.firstName);
  if (application.telegramUsername !== undefined) {
    const username = escapeHtml(`@${application.telegramUsername}`);
    return name === undefined ? username : `${name} (${username})`;
  }
  const code = `код ${escapeHtml(applicationCode(application.identityId))}`;
  return `${name ?? "Без имени"} · ${code}`;
}

function sourceLabel(source: ApplicationCard["source"]): string {
  switch (source.kind) {
    case "channel":
      return `канал «${escapeHtml(source.label)}»`;
    case "unknown":
      return "неизвестный канал";
    case "none":
      return "напрямую";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function plural(count: number, forms: [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;
  const form =
    tens >= 11 && tens <= 14
      ? forms[2]
      : ones === 1
        ? forms[0]
        : ones >= 2 && ones <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}

/** Возраст заявки: «только что», «5 минут назад», «3 часа назад», «2 дня назад». */
export function ageLabel(createdAtMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - createdAtMs) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) {
    return `${plural(minutes, ["минуту", "минуты", "минут"])} назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, ["час", "часа", "часов"])} назад`;
  return `${plural(Math.floor(hours / 24), ["день", "дня", "дней"])} назад`;
}

/**
 * Карточка ведёт в профиль только по публичному username. Допуск зелёный,
 * отказ красный (решение владельца по PER-534).
 */
export function applicationCardScreen(
  queue: ApplicationQueue,
  { application, position }: { application: ApplicationCard; position: number },
  total: number,
  nowMs: number,
): ShownScreen {
  const cursor = cursorOf(application);
  const data = cardCursorData(cursor);
  const domain = queueDomain(queue);
  const rows = new InlineKeyboard()
    .text("Допустить", `${domain}:qa:${data}`)
    .success()
    .row()
    .text("Отказать", `${domain}:qd:${data}`)
    .danger();
  if (application.telegramUsername !== undefined) {
    rows.row().url("Профиль ↗", `https://t.me/${application.telegramUsername}`);
  }
  rows.row().text("Пропустить", `${domain}:q:${data}`);
  const keyboard = withNav(rows, toManage);
  return {
    id: "application",
    text: screenText(
      `Заявка ${position} из ${total} · ${circleLabel[application.circle]}`,
      [
        personHtml(application),
        `Пришёл: ${sourceLabel(application.source)} · ${ageLabel(application.createdAtMs, nowMs)}`,
      ].join("\n"),
    ),
    keyboard,
    format: "HTML",
  };
}

/**
 * Карточки нет: очередь пуста или за курсором заявок не осталось. Конец очереди
 * не возвращает к первой сам — пропущенные заявки открываются заново только
 * кнопкой «С начала».
 */
export function applicationQueueEndScreen(
  queue: ApplicationQueue,
  total: number,
  afterCursor: boolean,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (afterCursor && total > 0) {
    keyboard.text("С начала", `${queueDomain(queue)}:q`);
  }
  return {
    id: "application",
    text: screenText(
      queueTitle(queue),
      total === 0
        ? "Новых заявок нет."
        : afterCursor
          ? `Очередь кончилась. Ещё открыто заявок: ${total}.`
          : undefined,
    ),
    keyboard: withNav(keyboard, toManage),
    format: "HTML",
  };
}

/**
 * Подтверждение отказа называет последствие по кругу. Отказ — исход `declined`
 * только своей очереди (ADR-064, пункт 15): в аукцион — закрытая заявка на
 * аукцион без блокировки профиля, в хаб — закрытая заявка в хаб.
 */
export function declineConfirmScreen(
  queue: ApplicationQueue,
  application: ApplicationCard,
): ShownScreen {
  const person = personHtml(application);
  const consequence =
    application.circle === "public"
      ? `Заявка ${person} в аукцион будет отклонена. Профиль не блокируется, и путь в сообщество остаётся открытым.`
      : `Заявка ${person} в хаб будет отклонена. Доступ к аукциону, если он есть, останется.`;
  const cursor = cursorOf(application);
  return {
    id: "application-decline-confirm",
    text: screenText("Отказать?", consequence),
    keyboard: confirmKeyboard({
      yes: "Да, отказать",
      yesData: `${queueDomain(queue)}:qy:${cardCursorData(cursor)}`,
      noData: sameCardData(queue, cursor),
      style: "danger",
    }),
    format: "HTML",
  };
}

const outcomeLabel: Record<ApplicationDecision["outcome"], string> = {
  admitted: "допущен",
  declined: "отклонена",
  blocked: "заблокирован",
  "closed-by-grant": "доступ выдан без заявки",
  "closed-by-block": "профиль заблокирован",
};

function deciderLabel(decision: ApplicationDecision): string {
  const decider = decision.decidedBy;
  if (decider === undefined) return "по разрешённому нику";
  return decider.telegramUsername === undefined
    ? `id ${decider.telegramUserId}`
    : `@${decider.telegramUsername}`;
}

/**
 * Всплывающий ответ на решение. Второй администратор на той же заявке узнаёт,
 * чем и кем она уже решена (ADR-060, пункт 9).
 */
export function decisionToast(decision: ApplicationDecision): string {
  if (decision.already) {
    return `Уже решено: ${outcomeLabel[decision.outcome]}, ${deciderLabel(decision)}.`;
  }
  switch (decision.outcome) {
    case "admitted":
      return "Человек допущен.";
    case "blocked":
      return "Отказано: профиль заблокирован.";
    default:
      return "Заявка отклонена.";
  }
}
