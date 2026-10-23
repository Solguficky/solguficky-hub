import { InlineKeyboard } from "grammy";
import type { CommunityDay } from "../../community-time.js";
import { communityDay } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  bullet,
  dayLabel,
  escapeHtml,
  type Parent,
  readableDay,
  screenText,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

const toHelp: Parent = { name: "Помощь", data: "v1:nav:help" };

export type ReleasePostTarget = { summaryId: string; part: number };

export type ReleasePostView = {
  kind: "release-post";
  summaryId: string;
  summarizedAt: string;
  lines: readonly string[];
  part: number;
  partCount: number;
  older?: ReleasePostTarget;
  newer?: ReleasePostTarget;
};

export function releasePostData(target?: ReleasePostTarget): `v1:${string}` {
  if (target === undefined) return "v1:wn";
  const token = uuidToToken(target.summaryId);
  return target.part <= 1 ? `v1:wn:${token}` : `v1:wn:${token}:${target.part}`;
}

export function releaseEmptyScreen(): ShownScreen {
  return {
    id: "whats-new",
    text: screenText("Что нового", "Пока ничего нового."),
    keyboard: withNav(new InlineKeyboard(), toHelp),
    format: "HTML",
  };
}

export function releasePostScreen(
  view: ReleasePostView,
  today: CommunityDay,
  timeZone: string,
): ShownScreen | undefined {
  const label = summaryLabel(
    view.summarizedAt,
    timeZone,
    today,
    view.part,
    view.partCount,
  );
  if (label === undefined) return undefined;
  const keyboard = new InlineKeyboard();
  if (view.older !== undefined) {
    keyboard.text("←", releasePostData(view.older));
  }
  if (view.newer !== undefined) {
    keyboard.text("→", releasePostData(view.newer));
  }
  return {
    id: "whats-new",
    text: screenText(
      "Что нового",
      `Сводка: ${escapeHtml(label)}`,
      view.lines.map((line) => bullet(escapeHtml(line))).join("\n"),
    ),
    keyboard: withNav(keyboard, toHelp),
    format: "HTML",
  };
}

export function releaseTraceDay(
  summarizedAt: string,
  timeZone: string,
  today: CommunityDay,
): string | undefined {
  const day = communityDate(summarizedAt, timeZone);
  return day === undefined ? undefined : dayLabel(day, today);
}

function summaryLabel(
  summarizedAt: string,
  timeZone: string,
  today: CommunityDay,
  part: number,
  partCount: number,
): string | undefined {
  const day = communityDate(summarizedAt, timeZone);
  if (day === undefined) return undefined;
  const readable = readableDay(day, today);
  return partCount > 1 ? `${readable} (${part}/${partCount})` : readable;
}

function communityDate(
  summarizedAt: string,
  timeZone: string,
): CommunityDay | undefined {
  const at = new Date(summarizedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  try {
    return communityDay(at, timeZone);
  } catch {
    return undefined;
  }
}
