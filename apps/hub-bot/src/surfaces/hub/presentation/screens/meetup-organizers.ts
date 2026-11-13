import { InlineKeyboard } from "grammy";
import type { RosterEntry } from "../../application/types.js";
import type { OrganizerCandidateResult } from "../../identity/port.js";
import type { MeetupSnapshot } from "../../meetups/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  bullet,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  organizersData,
  outcomeText,
  type Parent,
  screenText,
  submenuText,
  toCard,
  toOrganizers,
  withNav,
} from "./kit.js";
import { meetupTitleLabel } from "./meetup.js";
import type { ShownScreen } from "./show.js";

// «Организаторы» сходки (ADR-076, п. 6–8; PER-749): состав в порядке
// вступления, «Добавить» по нику, «Снять» — только администратору (дополнение
// 2026-11-13 к п. 6, PER-879) — и «Выйти». Право на каждое действие решает
// Meetups на команде, а экран прячет только кнопки, которые заведомо ведут в
// отказ.

/** «Добавить»: вопрос о нике. */
export function appointOrganizerData(token: string): string {
  return `v1:mo:a:${token}`;
}

/** «Выйти»: подтверждение выхода. С ним же — кнопка из вести о назначении. */
export function leaveOrganizersData(token: string): string {
  return `v1:mo:lq:${token}`;
}

export const appointOrganizerPrompt =
  "Кого назначить организатором? Отправь ник с @ или без.";

export type OrganizersView = {
  meetup: MeetupSnapshot;
  roster: readonly RosterEntry[];
  viewerId: string;
  /** Смотрящий держит `manage-meetups`: снимать из состава может только он. */
  administrator: boolean;
};

/**
 * Подпись человека состава: «ты», ник или номер в составе. Номер — для того,
 * кого Identity не назвала (заблокирован или без права, ADR-076, п. 10): у
 * него тоже есть «Снять», иначе администратор не уберёт его из состава.
 */
export function rosterLabel(
  entry: RosterEntry,
  place: number,
  viewerId: string,
): string {
  if (entry.identityId === viewerId) return "ты";
  return entry.contact?.kind === "username"
    ? `@${entry.contact.telegramUsername}`
    : `организатор №${place}, без ника`;
}

function dismissButtonLabel(entry: RosterEntry, place: number): string {
  return entry.contact?.kind === "username"
    ? `Снять @${entry.contact.telegramUsername}`
    : `Снять №${place}`;
}

/**
 * «Снять» видит только администратор: у каждого в составе, в том числе у
 * автора и у человека без ника, кроме себя — себе «Выйти». Организатор
 * назначает, но не снимает (ADR-076, дополнение 2026-11-13 к п. 6).
 */
export function dismissable(view: OrganizersView, identityId: string): boolean {
  return view.administrator && identityId !== view.viewerId;
}

export function organizersScreen(view: OrganizersView): ShownScreen {
  const { meetup, roster, viewerId } = view;
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  roster.forEach((entry, index) => {
    if (!dismissable(view, entry.identityId)) return;
    nextRow(keyboard).text(
      dismissButtonLabel(entry, index + 1),
      `v1:mo:dq:${token}:${uuidToToken(entry.identityId)}`,
    );
  });
  if (meetup.lifecycle !== "cancelled") {
    nextRow(keyboard).text("Добавить", appointOrganizerData(token));
  }
  if (roster.some((entry) => entry.identityId === viewerId)) {
    nextRow(keyboard).text("Выйти", leaveOrganizersData(token));
  }
  const lines =
    roster.length === 0
      ? "В составе никого: сходку ведёт администратор."
      : roster
          .map((entry, index) =>
            bullet(
              `${escapeHtml(rosterLabel(entry, index + 1, viewerId))}${entry.identityId === meetup.author ? " · автор" : ""}`,
            ),
          )
          .join("\n");
  return {
    id: "meetup-organizers",
    text: submenuText(
      "Организаторы",
      meetupTitleLabel(meetup.title),
      lines,
      "Организаторы ведут сходку наравне и назначают других. Снимает из состава только администратор, а сам организатор может выйти.",
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

/** Подтверждение назначения: в «Да» — человек, которого нашла Identity. */
export function appointOrganizerConfirmScreen(
  meetup: MeetupSnapshot,
  candidate: { identityId: string; telegramUsername: string },
  self: boolean,
): ShownScreen {
  const token = uuidToToken(meetup.id);
  const title = meetupTitleLabel(meetup.title);
  return {
    id: "organizer-appoint-confirm",
    text: screenText(
      "Назначить организатором?",
      `<b>@${escapeHtml(candidate.telegramUsername)}</b>`,
      self
        ? `Это ты: ты будешь вести сходку «${escapeHtml(title)}».`
        : `Человек будет вести сходку «${escapeHtml(title)}» и сможет назначать других. Ему придёт сообщение о назначении.`,
    ),
    keyboard: confirmKeyboard({
      yes: "Да, назначить",
      yesData: `v1:mo:ay:${token}:${uuidToToken(candidate.identityId)}`,
      noData: organizersData(token),
    }),
    format: "HTML",
  };
}

/** Подтверждение снятия другого человека; «Нет» возвращает в состав. */
export function dismissOrganizerConfirmScreen(
  meetup: MeetupSnapshot,
  entry: RosterEntry,
  place: number,
  viewerId: string,
): ShownScreen {
  const token = uuidToToken(meetup.id);
  return {
    id: "organizer-dismiss-confirm",
    text: screenText(
      "Снять организатора?",
      `<b>${escapeHtml(rosterLabel(entry, place, viewerId))}</b>`,
      `Человек перестанет вести сходку «${escapeHtml(meetupTitleLabel(meetup.title))}». Ему придёт сообщение. Назначить снова можно по нику.`,
    ),
    keyboard: confirmKeyboard({
      yes: "Да, снять",
      yesData: `v1:mo:dy:${token}:${uuidToToken(entry.identityId)}`,
      noData: organizersData(token),
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение выхода. Открывается и с экрана состава, и кнопкой из вести о
 * назначении: весть живёт долго, поэтому выход не идёт с неё сразу.
 */
export function leaveOrganizersConfirmScreen(
  meetup: MeetupSnapshot,
): ShownScreen {
  const token = uuidToToken(meetup.id);
  return {
    id: "organizer-leave-confirm",
    text: screenText(
      "Выйти из организаторов?",
      `<b>${escapeHtml(meetupTitleLabel(meetup.title))}</b>`,
      "Ты перестанешь вести эту сходку. Вернуть тебя может другой организатор или администратор.",
    ),
    keyboard: confirmKeyboard({
      yes: "Да, выйти",
      yesData: `v1:mo:ly:${token}`,
      noData: toCard(token).data,
    }),
    format: "HTML",
  };
}

/** Исход действия с составом: возврат в состав или, после выхода, в сходку. */
export function organizersOutcomeScreen(
  outcome: string,
  subject: string | undefined,
  parent: Parent,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(outcome, subject),
    keyboard: withNav(new InlineKeyboard(), parent),
    format: "HTML",
  };
}

/** Исход над присланным ником: над возвратом — «Ввести заново». */
export function appointOrganizerRetryScreen(
  outcome: string,
  subject: string | undefined,
  token: string,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(outcome, subject),
    keyboard: withNav(
      new InlineKeyboard().text("Ввести заново", appointOrganizerData(token)),
      toOrganizers(token),
    ),
    format: "HTML",
  };
}

/**
 * Текст отказа Identity на поиск по нику (критерий PER-749: свой кадр на
 * каждый случай). `forbidden`, `invalid` и `unavailable` сюда не входят: у них
 * свои кадры отказа и сбоя.
 */
export function candidateRefusalText(
  result: Exclude<
    OrganizerCandidateResult,
    | { kind: "ok" }
    | { kind: "forbidden" }
    | { kind: "invalid" }
    | { kind: "unavailable" }
  >,
): string {
  switch (result.kind) {
    case "username-unknown":
      return "Ник не найден. Такого ника нет ни у кого, кто писал боту: проверь написание.";
    case "username-unresolved":
      return "Ник не определяет человека. Этот ник сейчас у нескольких профилей: попроси человека написать боту и попробуй снова.";
    case "not-member":
      return "Этот человек не в сообществе. Организатором назначают только участника.";
    case "blocked":
      return "Профиль заблокирован. Организатором его не назначить.";
    case "no-organize-right":
      return "У человека нет права вести сходки. Организатором его не назначить.";
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/** Отказ Meetups по праву смотрящего — один кадр на все причины (п. 9 и 12). */
export const organizersForbiddenText =
  "Это может только организатор сходки или администратор.";
/** Отказ на «Снять» без права администратора: снимает только он. */
export const dismissForbiddenText =
  "Снимать организаторов может только администратор. Сам организатор может выйти из состава.";
export const lastOrganizerText =
  "Ты последний в составе. Сходка не останется без организатора: сначала добавь другого, а снять последнего может только администратор.";
export const appointCancelledText =
  "Сходка отменена. Назначать организаторов отменённой сходки нельзя.";
export const appointPreconditionText =
  "Человек не может стать организатором. У него больше нет права вести сходки.";
export const organizerSearchFailedText =
  "Не получилось проверить ник. Это на моей стороне. Пришли ник ещё раз через минуту.";
export const organizersConflictText =
  "Состав успел измениться. Проверь его и повтори.";

/**
 * Текст успеха команды состава; `changed: false` — состав уже был таким,
 * `emptied` — после выхода в составе никого: сходку ведёт администратор.
 */
export function organizersChangedText(
  change: "appoint" | "dismiss" | "leave",
  changed: boolean,
  emptied = false,
): string {
  switch (change) {
    case "appoint":
      return changed
        ? "Организатор назначен. Человеку придёт сообщение о назначении."
        : "Уже организатор. Ничего не изменилось.";
    case "dismiss":
      return changed
        ? "Организатор снят. Человеку придёт сообщение."
        : "Уже не в составе. Ничего не изменилось.";
    case "leave":
      return !changed
        ? "Ты уже не в составе. Ничего не изменилось."
        : emptied
          ? "Ты вышел из организаторов. В составе никого: сходку ведёт администратор."
          : "Ты вышел из организаторов. Сходку ведут остальные в составе.";
  }
}
