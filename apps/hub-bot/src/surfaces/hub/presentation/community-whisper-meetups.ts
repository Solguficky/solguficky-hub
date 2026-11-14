import type { Dispatcher } from "../application/dispatcher.js";
import { type CommunityDay, isBeforeDay } from "../community-time.js";
import type { MeetupSummary } from "../meetups/port.js";
import {
  botLink,
  openBotLabel,
  type WhisperCommand,
  type WhisperFrame,
  type WhisperLink,
} from "./community-whisper.js";
import { dependencyCategory } from "./failure-category.js";
import { meetupStartLink } from "./meetup-deep-link.js";
import { dayLabel, screenText } from "./screens/kit.js";
import { meetupTitleLabel } from "./screens/meetup.js";

// `/meetups` в чате сообщества (PER-683; развилка D-2 плана эпика PER-679):
// ближайшие сходки шёпотом, по ссылке в бот на каждую — карточка открывается
// в личке, экраны в чате не живут (решение владельца Q-5, 2026-11-14).

/** Столько сходок шёпот называет; остальные — за рядом «Все сходки в боте». */
export const whisperMeetupLimit = 5;

const title = "Ближайшие сходки";

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
): (MeetupSummary & { schedule: CommunityDay })[] {
  return meetups
    .filter(
      (meetup): meetup is MeetupSummary & { schedule: CommunityDay } =>
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

export function meetupsWhisperFrame(
  meetups: readonly (MeetupSummary & { schedule: CommunityDay })[],
  today: CommunityDay,
  botUsername: string,
): WhisperFrame {
  if (meetups.length === 0) {
    return {
      id: "whisper-meetups",
      text: screenText(title, "Ближайших сходок нет."),
      links: [{ label: openBotLabel, url: botLink(botUsername) }],
    };
  }
  const links: WhisperLink[] = meetups
    .slice(0, whisperMeetupLimit)
    .map((meetup) => ({
      label: `${dayLabel(meetup.schedule, today)} · ${meetupTitleLabel(meetup.title)}`,
      url: meetupStartLink(botUsername, meetup.id),
    }));
  if (meetups.length > whisperMeetupLimit) {
    links.push({ label: "Все сходки в боте", url: botLink(botUsername) });
  }
  return { id: "whisper-meetups", text: screenText(title), links };
}

export function meetupsWhisper(dispatcher: Dispatcher): WhisperCommand {
  return {
    useCase: "find_meetup",
    async answer({ person, meta, botUsername, today }) {
      const result = await dispatcher.execute({
        identity: person,
        intent: "list-visible-meetups",
        ...meta,
      });
      if (result.kind === "meetup-list") {
        return {
          kind: "frame",
          frame: meetupsWhisperFrame(
            whisperableMeetups(result.meetups, today),
            today,
            botUsername,
          ),
        };
      }
      const reason = "reason" in result ? String(result.reason) : result.kind;
      return {
        kind: "failed",
        message: "meetup list rejected",
        category:
          result.kind === "dependency-rejected"
            ? dependencyCategory(reason)
            : "unexpected",
        error: reason,
      };
    },
  };
}
