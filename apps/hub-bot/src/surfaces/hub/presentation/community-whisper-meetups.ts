import { pictogram } from "../../../core/pictograms.js";
import type { Dispatcher } from "../application/dispatcher.js";
import { type CommunityDay, isBeforeDay } from "../community-time.js";
import type { MeetupSummary } from "../meetups/port.js";
import {
  meetupsInBotButton,
  type WhisperAction,
  type WhisperAnswer,
  type WhisperButton,
  type WhisperCommand,
  type WhisperFrame,
  type WhisperRequest,
  type WhisperRow,
  whisperActionData,
  whisperFailure,
} from "./community-whisper.js";
import {
  meetupStartLink,
  meetupsSectionStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { dayLabel, screenText } from "./screens/kit.js";
import { meetupTitleLabel } from "./screens/meetup.js";

// `/meetups` в чате сообщества (PER-683; развилка D-2 плана эпика PER-679):
// ближайшие сходки шёпотом, по ссылке в бот на каждую — карточка открывается
// в личке, экраны в чате не живут (решение владельца Q-5, 2026-11-14). Рядом
// со ссылкой в том же ряду — колокольчик подписки без текста (PER-686,
// PER-914; ADR-078, п. 5): подписка меняется тем же `SetSubscription`, что в
// карточке лички, и шёпот правится на месте тем же кадром, что даёт повтор
// команды.

/** Столько сходок шёпот называет; остальные — за рядом «Все сходки в боте». */
export const whisperMeetupLimit = 5;

/** Имя действия подписки в данных кнопки шёпота. */
export const subscriptionAction = "sub";

const title = "Ближайшие сходки";

type Whisperable = MeetupSummary & { schedule: CommunityDay };

/**
 * Что из видимого человеку можно шепнуть (ADR-078, п. 4): только
 * опубликованные сходки с датой не раньше сегодняшнего дня сообщества, по
 * дате. Скрытую Meetups отдаёт автору, составу и администратору, но она может
 * остаться скрытой и дальше — в шёпот она не идёт ни у кого. Сходка без даты
 * ближайшей не бывает, как и у `/next`: кадр называет их числом строкой
 * «И ещё N без даты — в боте» (PER-914).
 */
export function whisperableMeetups(
  meetups: readonly MeetupSummary[],
  today: CommunityDay,
): Whisperable[] {
  return meetups
    .filter(
      (meetup): meetup is Whisperable =>
        meetup.visibility === "visible" &&
        meetup.schedule !== undefined &&
        !isBeforeDay(meetup.schedule, today),
    )
    .sort((left, right) =>
      isBeforeDay(left.schedule, right.schedule)
        ? -1
        : isBeforeDay(right.schedule, left.schedule)
          ? 1
          : 0,
    );
}

/**
 * Сколько видимых сходок без даты не попало в ближайшие (PER-914): их шёпот
 * не называет, но человеку говорят, что они есть в боте. Скрытую Meetups
 * отдаёт автору и администратору, но в шёпот она не идёт ни у кого, поэтому
 * в счёт не попадает (ADR-078, п. 4).
 */
export function undatedVisibleCount(meetups: readonly MeetupSummary[]): number {
  return meetups.filter(
    (meetup) =>
      meetup.visibility === "visible" && meetup.schedule === undefined,
  ).length;
}

/**
 * Кадр списка. `subscribed` — подписка по сходке: сходка без записи —
 * Notifications не ответил, — и переключателя у неё нет, как у карточки.
 * `undated` — сколько видимых сходок без даты осталось за кадром.
 *
 * Ссылка на сходку и её колокольчик стоят одним рядом (PER-914), а сам
 * колокольчик несёт только значок, без текста: так видно, к какой сходке
 * относится действие, и подпись ничего не обрезает.
 */
export function meetupsWhisperFrame(
  meetups: readonly Whisperable[],
  today: CommunityDay,
  botUsername: string,
  subscribed: Readonly<Record<string, boolean>> = {},
  undated = 0,
): WhisperFrame {
  const rest = undated === 0 ? undefined : `И ещё ${undated} без даты — в боте`;
  if (meetups.length === 0) {
    return {
      id: "whisper-meetups",
      text: screenText(title, "Ближайших сходок нет.", rest),
      buttons: [meetupsInBotButton(botUsername)],
    };
  }
  const buttons: (WhisperButton | WhisperRow)[] = meetups
    .slice(0, whisperMeetupLimit)
    .map((meetup) => {
      const link: WhisperButton = {
        label: `${dayLabel(meetup.schedule, today)} · ${meetupTitleLabel(meetup.title)}`,
        url: meetupStartLink(botUsername, meetup.id),
      };
      const state = subscribed[meetup.id];
      if (state === undefined) return link;
      // Кнопка несёт целевое состояние, а не переворот: повтор нажатия ставит
      // то же значение (как `v1:notify:sub` карточки).
      const toggle: WhisperButton = {
        label: state ? pictogram.off : pictogram.on,
        data: whisperActionData(
          subscriptionAction,
          `${uuidToToken(meetup.id)}:${state ? "0" : "1"}`,
        ),
      };
      return [link, toggle];
    });
  if (meetups.length > whisperMeetupLimit) {
    // Ссылка без payload открыла бы чат без нового сообщения у того, кто
    // уже писал боту: `/start meetups` присылает сам раздел «Сходки».
    buttons.push({
      label: "Все сходки в боте",
      url: meetupsSectionStartLink(botUsername),
    });
  }
  return { id: "whisper-meetups", text: screenText(title, rest), buttons };
}

export function meetupsWhisper(dispatcher: Dispatcher): WhisperCommand {
  return {
    useCase: "find_meetup",
    async answer(request) {
      const listed = await listWhisperable(dispatcher, request);
      if (listed.kind === "failed") return listed;
      return frameOf(dispatcher, request, listed.meetups, {}, listed.undated);
    },
  };
}

// Аргумент кнопки подписки: токен сходки и целевое состояние.
const subscriptionArgument = /^([A-Za-z0-9_-]{22}):([01])$/;

/**
 * Переключатель подписки на шёпоте (PER-686). Сходка проверяется до записи:
 * подписка меняется только у той, что шёпот мог показать, — подделанная кнопка
 * скрытой, прошедшей или невидимой человеку сходки подписки не меняет, а
 * шёпот показывает текущий список.
 */
export function subscriptionWhisper(dispatcher: Dispatcher): WhisperAction {
  return {
    useCase: "manage_notifications",
    async answer(request) {
      const listed = await listWhisperable(dispatcher, request);
      if (listed.kind === "failed") return listed;
      const matched = subscriptionArgument.exec(request.argument);
      const meetupId =
        matched?.[1] === undefined ? undefined : tokenToUuid(matched[1]);
      if (
        meetupId === undefined ||
        !listed.meetups.some((meetup) => meetup.id === meetupId)
      ) {
        const shown = await frameOf(
          dispatcher,
          request,
          listed.meetups,
          {},
          listed.undated,
        );
        return shown.kind === "frame"
          ? { ...shown, refused: "meetup is not whisperable" }
          : shown;
      }
      const changed = await dispatcher.execute({
        identity: request.person,
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: matched?.[2] === "1",
        ...request.meta,
      });
      // Намерение лички пишет подписку до чтения сходки: сходку, которую
      // скрыли между списком и записью, оно не находит уже после записи.
      // Исход тогда известен Notifications — шёпот показывает текущий список
      // с прочитанным состоянием, а не недоступность.
      if (changed.kind === "meetup-not-found") {
        const fresh = await listWhisperable(dispatcher, request);
        if (fresh.kind === "failed") return fresh;
        const shown = await frameOf(
          dispatcher,
          request,
          fresh.meetups,
          {},
          fresh.undated,
        );
        return shown.kind === "frame"
          ? { ...shown, refused: "meetup is not whisperable" }
          : shown;
      }
      if (changed.kind !== "meetup-card" || changed.subscribed === undefined) {
        return whisperFailure("meetup subscription rejected", changed);
      }
      return frameOf(
        dispatcher,
        request,
        listed.meetups,
        { [meetupId]: changed.subscribed },
        listed.undated,
      );
    },
  };
}

async function listWhisperable(
  dispatcher: Dispatcher,
  request: WhisperRequest,
): Promise<
  | { kind: "listed"; meetups: Whisperable[]; undated: number }
  | Extract<WhisperAnswer, { kind: "failed" }>
> {
  const result = await dispatcher.execute({
    identity: request.person,
    intent: "list-visible-meetups",
    ...request.meta,
  });
  return result.kind === "meetup-list"
    ? {
        kind: "listed",
        meetups: whisperableMeetups(result.meetups, request.today),
        undated: undatedVisibleCount(result.meetups),
      }
    : whisperFailure("meetup list rejected", result);
}

// Подписку читает только у названных сходок; `known` — то, что уже ответила
// запись, и второй раз его не читают.
async function frameOf(
  dispatcher: Dispatcher,
  request: WhisperRequest,
  meetups: readonly Whisperable[],
  known: Readonly<Record<string, boolean>> = {},
  undated = 0,
): Promise<WhisperAnswer> {
  const unknown = meetups
    .slice(0, whisperMeetupLimit)
    .map((meetup) => meetup.id)
    .filter((id) => !Object.hasOwn(known, id));
  const read =
    unknown.length === 0
      ? undefined
      : await dispatcher.execute({
          identity: request.person,
          intent: "read-meetup-subscriptions",
          meetupIds: unknown,
          ...request.meta,
        });
  const subscribed = {
    ...(read?.kind === "meetup-subscriptions" ? read.subscribed : {}),
    ...known,
  };
  return {
    kind: "frame",
    frame: meetupsWhisperFrame(
      meetups,
      request.today,
      request.botUsername,
      subscribed,
      undated,
    ),
  };
}
