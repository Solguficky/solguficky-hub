import { uuidV7Of } from "../../../core/uuid-v7.js";
import type { Dispatcher } from "../application/dispatcher.js";
import type { ExecuteResult } from "../application/types.js";
import { type CommunityDay, isBeforeDay } from "../community-time.js";
import type { MeetupSnapshot } from "../meetups/port.js";
import {
  openBotLabel,
  openBotLink,
  type WhisperAction,
  type WhisperAnswer,
  type WhisperButton,
  type WhisperCommand,
  type WhisperCommandEcho,
  type WhisperFrame,
  type WhisperRequest,
  whisperActionData,
} from "./community-whisper.js";
import { whisperableMeetups } from "./community-whisper-meetups.js";
import { dependencyCategory } from "./failure-category.js";
import { materialTitleLimit, messageLinkOf } from "./material-input.js";
import {
  meetupStartLink,
  tokenToUuid,
  uuidToToken,
} from "./meetup-deep-link.js";
import { canOrganizeMeetups, meetupViewer } from "./meetup-people.js";
import { dayLabel, escapeHtml, screenText } from "./screens/kit.js";
import { meetupTitleLabel } from "./screens/meetup.js";

// `/attach <ссылка> <название>` в чате сообщества (PER-885; ADR-078, п. 5 и
// дополнение 2026-11-19): ссылка на сообщение чата становится материалом
// сходки, не уходя из чата. Шёпот на команду — кнопки ближайших опубликованных
// сходок, где человек правит материалы (то же отношение `meetupViewer`, что у
// карточки), нажатие прикрепляет ссылку тем же `attach-material`, что шаг
// «Материал» лички, и правит шёпот на «прикреплено». Ссылку и название кнопка
// не несёт — в 64 байта они не помещаются: нажатие читает их из самой команды,
// которую Telegram приносит с ним (RFC-003, «Шёпот в группе»). Прошедшие
// сходки сюда не идут (решение владельца Q-24): к ним материал прикрепляется
// в личке.

/** Имя команды и действия в данных кнопки шёпота. */
export const attachCommand = "attach";
export const attachAction = "att";

/** Столько сходок шёпот предлагает; снимки читаются по ним параллельно. */
const attachMeetupLimit = 5;
// Столько ближайших сходок проверяется на отношение: организатор ведёт не
// каждую, а снимок — вызов Meetups в 15-секундном окне.
const attachCandidateLimit = 10;

const title = "Прикрепить материал";
const useCase = "update_meetup";

export type AttachArgument =
  | { kind: "ok"; url: string; title: string }
  | { kind: "hint"; reason: "empty" | "link" | "title" | "long" };

/**
 * Аргумент `/attach`: ссылка — первое слово, название — остальное, до 200
 * символов, как в личке. Невалидное даёт подсказку до любого вызова Meetups.
 */
export function parseAttachArgument(argument: string): AttachArgument {
  const text = argument.trim();
  if (text === "") return { kind: "hint", reason: "empty" };
  const space = text.search(/\s/);
  const link = space === -1 ? text : text.slice(0, space);
  const named = space === -1 ? "" : text.slice(space).trim();
  const url = messageLinkOf(link);
  if (url === undefined) return { kind: "hint", reason: "link" };
  if (named === "") return { kind: "hint", reason: "title" };
  if (named.length > materialTitleLimit) {
    return { kind: "hint", reason: "long" };
  }
  return { kind: "ok", url, title: named };
}

const hintReasons: Record<
  Extract<AttachArgument, { kind: "hint" }>["reason"],
  string
> = {
  empty: "Напиши после команды ссылку на сообщение и название материала.",
  link: "Первым словом после команды нужна ссылка на сообщение вида https://t.me/…",
  title: "После ссылки напиши название материала.",
  long: `Название длиннее ${materialTitleLimit} символов — сократи его.`,
};

function hintFrame(
  reason: Extract<AttachArgument, { kind: "hint" }>["reason"],
): WhisperFrame {
  return {
    id: "whisper-attach-hint",
    text: screenText(
      title,
      escapeHtml(hintReasons[reason]),
      escapeHtml(
        "Например: /attach https://t.me/c/1234567890/42 Фото со сходки",
      ),
      escapeHtml(
        `Ссылку даёт «Копировать ссылку» в меню сообщения. Название — до ${materialTitleLimit} символов.`,
      ),
    ),
    buttons: [],
  };
}

function noneFrame(botUsername: string): WhisperFrame {
  return {
    id: "whisper-attach-none",
    text: screenText(
      title,
      escapeHtml("Нет ближайших сходок, к которым ты прикрепляешь материалы."),
      escapeHtml(
        "К прошедшей сходке материал прикрепляется в боте: «Материалы» в её карточке.",
      ),
    ),
    buttons: [{ label: openBotLabel, url: openBotLink(botUsername) }],
  };
}

// Нажатие без своей команды: её удалили или кнопка подделана. Без команды нет
// ни ссылки, ни названия, и шёпот просит повторить.
const staleFrame: WhisperFrame = {
  id: "whisper-attach-stale",
  text: screenText(
    title,
    escapeHtml("Этот выбор устарел. Повтори команду /attach."),
  ),
  buttons: [],
};

type Candidate = {
  meetup: MeetupSnapshot;
  day: CommunityDay;
};

function listFrame(
  parsed: Extract<AttachArgument, { kind: "ok" }>,
  candidates: readonly Candidate[],
  request: WhisperRequest,
  notice?: string,
): WhisperFrame {
  if (candidates.length === 0) return noneFrame(request.botUsername);
  const buttons: WhisperButton[] = candidates.map(({ meetup, day }) => ({
    label: `${dayLabel(day, request.today)} · ${meetupTitleLabel(meetup.title)}`,
    data: whisperActionData(
      attachAction,
      `${uuidToToken(meetup.id)}:${meetup.version}`,
    ),
  }));
  buttons.push({
    label: openBotLabel,
    url: openBotLink(request.botUsername),
  });
  return {
    id: "whisper-attach",
    text: screenText(
      title,
      notice === undefined ? undefined : escapeHtml(notice),
      `Ссылка: ${escapeHtml(parsed.url)}\nНазвание: ${escapeHtml(parsed.title)}`,
      escapeHtml("К какой сходке прикрепить?"),
    ),
    buttons,
  };
}

function attachedFrame(
  meetup: MeetupSnapshot,
  materialTitle: string,
  botUsername: string,
): WhisperFrame {
  return {
    id: "whisper-attached",
    text: screenText(
      `Прикреплено к «${meetupTitleLabel(meetup.title)}»`,
      `Материал «${escapeHtml(materialTitle)}» — в «Материалах» карточки сходки.`,
    ),
    buttons: [
      {
        label: "Открыть сходку",
        url: meetupStartLink(botUsername, meetup.id),
      },
    ],
  };
}

export function attachWhisper(dispatcher: Dispatcher): WhisperCommand {
  return {
    useCase,
    async answer(request) {
      const parsed = parseAttachArgument(request.argument);
      if (parsed.kind === "hint") {
        return { kind: "frame", frame: hintFrame(parsed.reason) };
      }
      return listed(dispatcher, request, parsed);
    },
  };
}

// Аргумент кнопки: токен сходки и версия снимка, по которому человек выбрал.
const attachArgument = /^([A-Za-z0-9_-]{22}):(0|[1-9]\d{0,8})$/;

/**
 * Нажатие на сходку шёпота `/attach`. Сходка проверяется до записи тем же
 * правилом, что строило кнопки: подделанная кнопка скрытой, прошедшей,
 * отменённой или чужой сходки материала не прикрепляет. Версия — из кнопки,
 * как у подтверждения в личке (PER-393): сходку, изменившуюся после шёпота,
 * человек выбирает заново. Id материала выводится из команды и сходки, поэтому
 * повтор нажатия второго материала не заводит.
 */
export function attachMaterialWhisper(dispatcher: Dispatcher): WhisperAction {
  return {
    useCase,
    async answer(request) {
      const command = request.command;
      const parsed =
        command?.name === attachCommand
          ? parseAttachArgument(command.argument)
          : undefined;
      if (command === undefined || parsed?.kind !== "ok") {
        return {
          kind: "frame",
          frame: staleFrame,
          refused: "attach command is missing",
        };
      }
      const matched = attachArgument.exec(request.argument);
      const meetupId =
        matched?.[1] === undefined ? undefined : tokenToUuid(matched[1]);
      if (meetupId === undefined || matched?.[2] === undefined) {
        return refusedList(dispatcher, request, parsed, "forged attach press");
      }
      const read = await readSnapshot(dispatcher, request, meetupId);
      if (read.kind === "failed") return read;
      if (
        read.kind === "missing" ||
        candidateOf(request, read.meetup) === undefined
      ) {
        return refusedList(
          dispatcher,
          request,
          parsed,
          "meetup is not attachable",
        );
      }
      const materialId = attachedMaterialId(request.chatId, command, meetupId);
      if (
        read.meetup.materials.some((material) => material.id === materialId)
      ) {
        return {
          kind: "frame",
          frame: attachedFrame(read.meetup, parsed.title, request.botUsername),
        };
      }
      const result = await dispatcher.execute({
        identity: request.person,
        intent: "attach-material",
        meetupId,
        material: {
          id: materialId,
          title: parsed.title,
          source: { kind: "message-link", url: parsed.url },
        },
        expectedVersion: Number(matched[2]),
        ...request.meta,
      });
      if (result.kind === "material-attached") {
        return {
          kind: "frame",
          frame: attachedFrame(
            result.meetup,
            parsed.title,
            request.botUsername,
          ),
        };
      }
      if (result.kind === "conflict") {
        // Повтор нажатия после записи приходит конфликтом: материал уже в
        // перечитанном снимке, и это исход, а не отказ.
        if (
          result.meetup.materials.some((material) => material.id === materialId)
        ) {
          return {
            kind: "frame",
            frame: attachedFrame(
              result.meetup,
              parsed.title,
              request.botUsername,
            ),
          };
        }
        return refusedList(
          dispatcher,
          request,
          parsed,
          "meetup changed since the whisper",
          "Сходка только что изменилась — выбери её ещё раз.",
        );
      }
      if (result.kind === "meetup-not-found") {
        return refusedList(
          dispatcher,
          request,
          parsed,
          "meetup is not attachable",
        );
      }
      return failed("material attach rejected", result);
    },
  };
}

/**
 * Id материала из чата: команда — чат, её адрес и момент, — и сходка. Адрес
 * шёпота Telegram может отдать другому после истечения, момент это различает.
 */
export function attachedMaterialId(
  chatId: number,
  command: WhisperCommandEcho,
  meetupId: string,
): string {
  return uuidV7Of(
    `hub-bot:whisper-attach:${chatId}:${command.ephemeralMessageId}:${command.sentAt}:${meetupId}`,
    command.sentAt,
  );
}

// Сходка, к которой шёпот может прикрепить: опубликованная, не отменённая, с
// датой не раньше сегодня (ADR-078, п. 4) и где человек правит материалы.
function candidateOf(
  request: WhisperRequest,
  meetup: MeetupSnapshot,
): Candidate | undefined {
  const schedule = meetup.schedule;
  if (
    meetup.visibility !== "visible" ||
    meetup.lifecycle === "cancelled" ||
    schedule === undefined ||
    isBeforeDay(schedule, request.today) ||
    !meetupViewer(request.person, meetup).manages
  ) {
    return undefined;
  }
  return { meetup, day: schedule };
}

async function listed(
  dispatcher: Dispatcher,
  request: WhisperRequest,
  parsed: Extract<AttachArgument, { kind: "ok" }>,
  notice?: string,
): Promise<WhisperAnswer> {
  // Без права вести сходки отношения нет ни к одной: Meetups не читается.
  if (!canOrganizeMeetups(request.person)) {
    return { kind: "frame", frame: noneFrame(request.botUsername) };
  }
  const list = await dispatcher.execute({
    identity: request.person,
    intent: "list-visible-meetups",
    ...request.meta,
  });
  if (list.kind !== "meetup-list") return failed("meetup list rejected", list);
  const nearest = whisperableMeetups(list.meetups, request.today).slice(
    0,
    attachCandidateLimit,
  );
  const reads = await Promise.all(
    nearest.map((meetup) => readSnapshot(dispatcher, request, meetup.id)),
  );
  const failure = reads.find((read) => read.kind === "failed");
  if (failure?.kind === "failed") return failure;
  const candidates = reads
    .flatMap((read) => {
      if (read.kind !== "read") return [];
      const candidate = candidateOf(request, read.meetup);
      return candidate === undefined ? [] : [candidate];
    })
    .slice(0, attachMeetupLimit);
  return {
    kind: "frame",
    frame: listFrame(parsed, candidates, request, notice),
  };
}

async function refusedList(
  dispatcher: Dispatcher,
  request: WhisperRequest,
  parsed: Extract<AttachArgument, { kind: "ok" }>,
  refused: string,
  notice?: string,
): Promise<WhisperAnswer> {
  const shown = await listed(dispatcher, request, parsed, notice);
  return shown.kind === "frame" ? { ...shown, refused } : shown;
}

async function readSnapshot(
  dispatcher: Dispatcher,
  request: WhisperRequest,
  meetupId: string,
): Promise<
  | { kind: "read"; meetup: MeetupSnapshot }
  | { kind: "missing" }
  | Extract<WhisperAnswer, { kind: "failed" }>
> {
  const result = await dispatcher.execute({
    identity: request.person,
    intent: "read-meetup",
    meetupId,
    ...request.meta,
  });
  if (result.kind === "meetup-card") {
    return { kind: "read", meetup: result.meetup };
  }
  if (result.kind === "meetup-not-found") return { kind: "missing" };
  return failed("meetup read rejected", result);
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
