import { InlineKeyboard } from "grammy";
import { applicationCode } from "../../application/hub-access.js";
import type {
  ApplicationCard,
  ApplicationDecision,
} from "../../identity/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { type CardCursor, cardCursorData } from "../parse-callback.js";
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
// очереди держит Identity: от старых к новым.

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

/** `v1:cm:qc:…` — та же карточка, пока заявка открыта. */
export function sameCardData(cursor: CardCursor): string {
  return `v1:cm:qc:${cardCursorData(cursor)}`;
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
 * Карточка. Ссылка `tg://user?id=` открывает профиль, только если её пускают
 * настройки приватности человека, а иначе Telegram отклоняет всё сообщение.
 * Поэтому у карточки две клавиатуры: вторая ведёт в профиль по нику, а без ника
 * обходится без кнопки — человека и тогда называет код.
 */
export function applicationCardScreen(
  { application, position }: { application: ApplicationCard; position: number },
  total: number,
  nowMs: number,
): ShownScreen {
  const cursor = cursorOf(application);
  const data = cardCursorData(cursor);
  const keyboard = (profile: string | undefined) => {
    const rows = new InlineKeyboard()
      .text("Допустить", `v1:cm:qa:${data}`)
      .row()
      .text("Отказать", `v1:cm:qd:${data}`)
      .row();
    if (profile !== undefined) rows.url("Профиль ↗", profile).row();
    return withNav(rows.text("Пропустить", `v1:cm:q:${data}`), toManage);
  };
  return {
    id: "application",
    text: screenText(
      `Заявка ${position} из ${total} · ${circleLabel[application.circle]}`,
      [
        personHtml(application),
        `Пришёл: ${sourceLabel(application.source)} · ${ageLabel(application.createdAtMs, nowMs)}`,
      ].join("\n"),
    ),
    keyboard: keyboard(`tg://user?id=${application.telegramUserId}`),
    privacyFallback: keyboard(
      application.telegramUsername === undefined
        ? undefined
        : `https://t.me/${application.telegramUsername}`,
    ),
    format: "HTML",
  };
}

/**
 * Карточки нет: очередь пуста или за курсором заявок не осталось. Конец очереди
 * не возвращает к первой сам — пропущенные заявки открываются заново только
 * кнопкой «С начала».
 */
export function applicationQueueEndScreen(
  total: number,
  afterCursor: boolean,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (afterCursor && total > 0) keyboard.text("С начала", "v1:cm:q");
  return {
    id: "application",
    text: screenText(
      "Заявки",
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
 * Подтверждение отказа называет последствие по кругу (ADR-060, пункт 12): отказ
 * в аукцион — блокировка профиля, отказ в хаб — только закрытая заявка.
 */
export function declineConfirmScreen(
  application: ApplicationCard,
): ShownScreen {
  const person = personHtml(application);
  const consequence =
    application.circle === "public"
      ? `Профиль ${person} будет заблокирован: доступа к аукциону не будет.`
      : `Заявка ${person} в хаб будет отклонена. Доступ к аукциону, если он есть, останется.`;
  const cursor = cursorOf(application);
  return {
    id: "application-decline-confirm",
    text: screenText("Отказать?", consequence),
    keyboard: confirmKeyboard({
      yes: "Да, отказать",
      yesData: `v1:cm:qy:${cardCursorData(cursor)}`,
      noData: sameCardData(cursor),
      danger: true,
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
