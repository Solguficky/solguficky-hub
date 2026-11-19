import type { Dispatcher } from "../application/dispatcher.js";
import type { ExecuteResult } from "../application/types.js";
import { type CommunityDay, isBeforeDay } from "../community-time.js";
import type { MeetupSummary } from "../meetups/port.js";
import {
  openBotLabel,
  openBotLink,
  type WhisperAction,
  type WhisperAnswer,
  type WhisperButton,
  type WhisperCommand,
  type WhisperFrame,
  type WhisperRequest,
  whisperActionData,
} from "./community-whisper.js";
import { dependencyCategory } from "./failure-category.js";
import {
  meetupStartLink,
  meetupsSectionStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { dayLabel, screenText } from "./screens/kit.js";
import {
  meetupTitleLabel,
  subscribeLabel,
  unsubscribeLabel,
} from "./screens/meetup.js";

// `/meetups` в чате сообщества (PER-683; развилка D-2 плана эпика PER-679):
// ближайшие сходки шёпотом, по ссылке в бот на каждую — карточка открывается
// в личке, экраны в чате не живут (решение владельца Q-5, 2026-11-14). Под
// ссылкой сходки — переключатель подписки (PER-686; ADR-078, п. 5): подписка
// меняется тем же `SetSubscription`, что в карточке лички, и шёпот правится
// на месте тем же кадром, что даёт повтор команды.

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
 * ближайшей не бывает, как и у `/next`.
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
 * Кадр списка. `subscribed` — подписка по сходке: сходка без записи —
 * Notifications не ответил, — и переключателя у неё нет, как у карточки.
 */
export function meetupsWhisperFrame(
  meetups: readonly Whisperable[],
  today: CommunityDay,
  botUsername: string,
  subscribed: Readonly<Record<string, boolean>> = {},
): WhisperFrame {
  if (meetups.length === 0) {
    return {
      id: "whisper-meetups",
      text: screenText(title, "Ближайших сходок нет."),
      buttons: [{ label: openBotLabel, url: openBotLink(botUsername) }],
    };
  }
  const buttons: WhisperButton[] = meetups
    .slice(0, whisperMeetupLimit)
    .flatMap((meetup) => {
      const link: WhisperButton = {
        label: `${dayLabel(meetup.schedule, today)} · ${meetupTitleLabel(meetup.title)}`,
        url: meetupStartLink(botUsername, meetup.id),
      };
      const state = subscribed[meetup.id];
      if (state === undefined) return [link];
      // Кнопка несёт целевое состояние, а не переворот: повтор нажатия ставит
      // то же значение (как `v1:notify:sub` карточки).
      const toggle: WhisperButton = {
        label: state ? unsubscribeLabel : subscribeLabel,
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
  return { id: "whisper-meetups", text: screenText(title), buttons };
}

export function meetupsWhisper(dispatcher: Dispatcher): WhisperCommand {
  return {
    useCase: "find_meetup",
    async answer(request) {
      const listed = await listWhisperable(dispatcher, request);
      if (listed.kind === "failed") return listed;
      return frameOf(dispatcher, request, listed.meetups);
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
        const shown = await frameOf(dispatcher, request, listed.meetups);
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
      if (changed.kind !== "meetup-card" || changed.subscribed === undefined) {
        return failed("meetup subscription rejected", changed);
      }
      return frameOf(dispatcher, request, listed.meetups, {
        [meetupId]: changed.subscribed,
      });
    },
  };
}

async function listWhisperable(
  dispatcher: Dispatcher,
  request: WhisperRequest,
): Promise<
  | { kind: "listed"; meetups: Whisperable[] }
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
      }
    : failed("meetup list rejected", result);
}

// Подписку читает только у названных сходок; `known` — то, что уже ответила
// запись, и второй раз его не читают.
async function frameOf(
  dispatcher: Dispatcher,
  request: WhisperRequest,
  meetups: readonly Whisperable[],
  known: Readonly<Record<string, boolean>> = {},
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
    ),
  };
}

function failed(
  message: string,
  result: ExecuteResult,
): Extract<WhisperAnswer, { kind: "failed" }> {
  const reason = "reason" in result ? String(result.reason) : result.kind;
  return {
    kind: "failed",
    message,
    category:
      result.kind === "dependency-rejected"
        ? dependencyCategory(reason)
        : "unexpected",
    error: reason,
  };
}
