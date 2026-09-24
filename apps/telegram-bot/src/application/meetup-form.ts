import type {
  MeetupSchedule,
  MeetupSnapshot,
  Meetups,
} from "../meetups/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  FormField,
  MeetupStateAction,
  Person,
} from "./types.js";

export function createMeetupForm(meetups: Meetups) {
  return async (
    request: Extract<
      ExecuteRequest,
      {
        intent:
          | "create-meetup"
          | "set-meetup-field"
          | "update-meetup-field"
          | "publish-meetup"
          | "schedule-publication"
          | "change-meetup-state";
      }
    >,
  ): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "create-meetup":
        return map(
          await meetups.createDraft(
            request.identity,
            request.meetupId,
            rpcMeta(request),
          ),
          "title",
        );
      case "set-meetup-field":
      case "update-meetup-field": {
        const editing = request.intent === "update-meetup-field";
        // Решение принимается по снимку, прочитанному здесь же, и он же едет
        // обратно как `expected_version`: команда, собранная по устаревшему
        // снимку, получает отказ, а не тихую перезапись чужой правки (PER-78).
        const current = await currentSnapshot(meetups, request);
        if (current.kind === "rejected") return current.result;
        if (editing && current.meetup.lifecycle === "cancelled") {
          return {
            kind: "edit-unavailable",
            reason: "cancelled",
            meetup: current.meetup,
          };
        }
        if (request.field === "schedule") {
          const schedule = parseSchedule(request.value);
          if (schedule === undefined) {
            return {
              kind: editing ? "edit-ask" : "ask",
              field: "schedule",
              meetup: current.meetup,
              error:
                "Не получилось разобрать дату. Напиши, например: 21.09.2026 19:30",
            };
          }
          const scheduled = await meetups.setSchedule(
            request.identity,
            current.meetup,
            schedule,
            rpcMeta(request),
          );
          if (scheduled.kind === "invalid") {
            return invalidField(
              request.field,
              current.meetup,
              scheduled.message,
              editing,
            );
          }
          if (scheduled.kind === "conflict") {
            return conflict(meetups, request, {
              field: request.field,
              input: request.value,
              ...(editing ? { editing } : {}),
            });
          }
          if (editing) {
            return scheduled.kind === "ok"
              ? { kind: "meetup-updated", meetup: scheduled.meetup }
              : failure(scheduled);
          }
          return map(scheduled, "venue");
        }
        const changed = { ...current.meetup, [request.field]: request.value };
        const next =
          request.field === "title"
            ? "schedule"
            : request.field === "venue"
              ? "description"
              : "preview";
        const updated = await meetups.changeAttributes(
          request.identity,
          changed,
          rpcMeta(request),
        );
        if (updated.kind === "invalid") {
          return invalidField(
            request.field,
            current.meetup,
            updated.message,
            editing,
          );
        }
        if (updated.kind === "conflict") {
          return conflict(meetups, request, {
            field: request.field,
            input: request.value,
            ...(editing ? { editing } : {}),
          });
        }
        if (editing) {
          return updated.kind === "ok"
            ? { kind: "meetup-updated", meetup: updated.meetup }
            : failure(updated);
        }
        return map(updated, next);
      }
      case "publish-meetup": {
        const current = await currentSnapshot(meetups, request);
        if (current.kind === "rejected") return current.result;
        const published = await meetups.publish(
          request.identity,
          current.meetup,
          rpcMeta(request),
        );
        if (published.kind === "conflict") {
          return conflict(meetups, request);
        }
        return mapPublished(published);
      }
      case "schedule-publication": {
        const current = await currentSnapshot(meetups, request);
        if (current.kind === "rejected") return current.result;
        const moment = parseSchedule(request.value);
        if (moment === undefined) {
          return {
            kind: "ask-publish-moment",
            meetup: current.meetup,
            retry: "unparsed",
          };
        }
        // Прошедший момент бот не отсекает по своим часам: решает Meetups в
        // поясе сообщества, и отказ приходит INVALID_ARGUMENT. Тот же код
        // означает момент, который пояс не представляет (переход на летнее
        // время, дата за пределами календаря сервиса), поэтому текст кадра
        // называет обе причины, а не только прошедшее время.
        const scheduled = await meetups.schedulePublication(
          request.identity,
          current.meetup,
          moment,
          rpcMeta(request),
        );
        if (scheduled.kind === "ok") {
          return { kind: "publication-scheduled", meetup: scheduled.meetup };
        }
        if (scheduled.kind === "invalid" && scheduled.precondition !== true) {
          return {
            kind: "ask-publish-moment",
            meetup: current.meetup,
            retry: "past",
          };
        }
        if (scheduled.kind === "invalid" || scheduled.kind === "conflict") {
          // Отказ по состоянию сходки и конфликт версий отвечают по
          // перечитанному снимку: показанный человеку экран устарел (E-04).
          const fresh = await currentSnapshot(meetups, request);
          if (fresh.kind === "rejected") return fresh.result;
          return scheduled.kind === "invalid"
            ? { kind: "publication-unavailable", meetup: fresh.meetup }
            : {
                kind: "ask-publish-moment",
                meetup: fresh.meetup,
                retry: "conflict",
              };
        }
        return failure(scheduled);
      }
      case "change-meetup-state": {
        const current = await meetups.get(
          request.identity,
          request.meetupId,
          rpcMeta(request),
        );
        if (current.kind === "not-found") return { kind: "meetup-not-found" };
        if (current.kind !== "ok") return failure(current);
        if (request.action === "hold") {
          // Повтор — успех без события (домен, MarkMeetupHeld); отдельного
          // ветвления «уже состоялась» не заводим и отдаём как есть.
          const changed = await meetups.markHeld(
            request.identity,
            current.meetup,
            rpcMeta(request),
          );
          if (changed.kind === "conflict") {
            return conflict(meetups, request, { action: request.action });
          }
          return changed.kind === "ok"
            ? {
                kind: "meetup-state-changed",
                action: request.action,
                meetup: changed.meetup,
              }
            : failure(changed);
        }
        if (current.meetup.lifecycle === "cancelled") {
          return {
            kind: "meetup-state-unchanged",
            reason: "already-cancelled",
            meetup: current.meetup,
          };
        }
        if (
          request.action === "unschedule" &&
          current.meetup.publishAt === undefined
        ) {
          return {
            kind: "meetup-state-unchanged",
            reason: "not-scheduled",
            meetup: current.meetup,
          };
        }
        if (
          request.action === "unpublish" &&
          current.meetup.visibility === "hidden"
        ) {
          return {
            kind: "meetup-state-unchanged",
            reason: "already-hidden",
            meetup: current.meetup,
          };
        }
        // Версия читается тем же снимком, что и решение о повторе выше: команда
        // изменения состояния несёт `expected_version` наравне с остальными
        // (PER-78), и конфликт с ней обрабатывается тем же путём, что и у формы.
        const changed =
          request.action === "unpublish"
            ? await meetups.unpublish(
                request.identity,
                current.meetup,
                rpcMeta(request),
              )
            : request.action === "unschedule"
              ? await meetups.cancelPublication(
                  request.identity,
                  current.meetup,
                  rpcMeta(request),
                )
              : await meetups.cancel(
                  request.identity,
                  current.meetup,
                  rpcMeta(request),
                );
        if (changed.kind === "conflict") {
          return conflict(meetups, request, { action: request.action });
        }
        return changed.kind === "ok"
          ? {
              kind: "meetup-state-changed",
              action: request.action,
              meetup: changed.meetup,
            }
          : failure(changed);
      }
      default: {
        const _exhaustive: never = request;
        return { kind: "rejected", reason: String(_exhaustive) };
      }
    }
  };
}

type FormRequest = Extract<
  ExecuteRequest,
  {
    intent:
      | "set-meetup-field"
      | "update-meetup-field"
      | "publish-meetup"
      | "schedule-publication"
      | "change-meetup-state";
  }
>;

/// Снимок, по которому принимается решение, или готовый отказ. Чтение одно на
/// команду: тем же снимком собирается целевое состояние и берётся версия.
async function currentSnapshot(
  meetups: Meetups,
  request: FormRequest,
): Promise<
  | { kind: "meetup"; meetup: MeetupSnapshot }
  | { kind: "rejected"; result: ExecuteResult }
> {
  const current = await meetups.get(
    request.identity,
    request.meetupId,
    rpcMeta(request),
  );
  if (current.kind === "not-found") {
    return {
      kind: "rejected",
      result: { kind: "dependency-rejected", reason: "unavailable" },
    };
  }
  if (current.kind !== "ok") {
    return { kind: "rejected", result: failure(current) };
  }
  return { kind: "meetup", meetup: current.meetup };
}

/// Конфликт версий: команда не применена, и человеку показывают текущее
/// состояние рядом с сохранённым вводом. Сам ввод повторно не отправляется —
/// его подтверждают заново по обновлённым данным (PER-78).
async function conflict(
  meetups: Meetups,
  request: FormRequest,
  saved?:
    | { field: FormField; input: string; editing?: boolean }
    | { action: MeetupStateAction },
): Promise<ExecuteResult> {
  const current = await currentSnapshot(meetups, request);
  if (current.kind === "rejected") return current.result;

  return {
    kind: "conflict",
    meetup: current.meetup,
    ...(saved ?? {}),
  };
}

function parseSchedule(value: string): MeetupSchedule | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  const [, dayRaw, monthRaw, yearRaw, hoursRaw, minutesRaw] = match;
  const schedule = {
    year: Number(yearRaw),
    month: Number(monthRaw),
    day: Number(dayRaw),
    hours: Number(hoursRaw),
    minutes: Number(minutesRaw),
  };
  const date = new Date(
    Date.UTC(
      schedule.year,
      schedule.month - 1,
      schedule.day,
      schedule.hours,
      schedule.minutes,
    ),
  );
  if (
    date.getUTCFullYear() !== schedule.year ||
    date.getUTCMonth() + 1 !== schedule.month ||
    date.getUTCDate() !== schedule.day ||
    schedule.hours > 23 ||
    schedule.minutes > 59
  )
    return undefined;
  return schedule;
}

function map(
  result: Awaited<ReturnType<Meetups["createDraft"]>>,
  next: "title" | "schedule" | "venue" | "description" | "preview",
): ExecuteResult {
  if (result.kind !== "ok") return failure(result);
  if (next === "preview") return { kind: "preview", meetup: result.meetup };
  return { kind: "ask", field: next, meetup: result.meetup };
}

function mapPublished(
  result: Awaited<ReturnType<Meetups["publish"]>>,
): ExecuteResult {
  if (result.kind !== "ok") return failure(result);
  return { kind: "published", meetup: result.meetup };
}

function failure(
  result: Exclude<Awaited<ReturnType<Meetups["createDraft"]>>, { kind: "ok" }>,
): ExecuteResult {
  if (result.kind === "invalid") {
    return {
      kind: "dependency-rejected",
      reason: "invalid",
      message: result.message,
    };
  }
  return { kind: "dependency-rejected", reason: result.kind };
}

function invalidField(
  field: FormField,
  meetup: MeetupSnapshot,
  message: string,
  editing = false,
): ExecuteResult {
  return {
    kind: editing ? "edit-ask" : "ask",
    field,
    meetup,
    error: `Не получилось сохранить значение: ${message}`,
  };
}

export function formatSchedule(meetup: MeetupSnapshot): string {
  const value = meetup.schedule;
  if (value === undefined) return "дата не задана";
  return formatLocalMoment(value);
}

/// Местные дата и время в виде `ДД.ММ.ГГГГ ЧЧ:ММ` — тот же вид, в котором их
/// вводят: расписание сходки и момент публикации читаются одинаково.
export function formatLocalMoment(value: MeetupSchedule): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(value.day)}.${pad(value.month)}.${value.year} ${pad(value.hours)}:${pad(value.minutes)}`;
}

export type { Person };
