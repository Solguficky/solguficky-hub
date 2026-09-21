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
        const current = await meetups.get(
          request.identity,
          request.meetupId,
          rpcMeta(request),
        );
        if (current.kind === "not-found") {
          return { kind: "dependency-rejected", reason: "unavailable" };
        }
        if (current.kind !== "ok") return failure(current);
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
            request.meetupId,
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
        if (editing) {
          return updated.kind === "ok"
            ? { kind: "meetup-updated", meetup: updated.meetup }
            : failure(updated);
        }
        return map(updated, next);
      }
      case "publish-meetup":
        return mapPublished(
          await meetups.publish(
            request.identity,
            request.meetupId,
            rpcMeta(request),
          ),
        );
      case "change-meetup-state": {
        const current = await meetups.get(
          request.identity,
          request.meetupId,
          rpcMeta(request),
        );
        if (current.kind === "not-found") return { kind: "meetup-not-found" };
        if (current.kind !== "ok") return failure(current);
        if (current.meetup.lifecycle === "cancelled") {
          return {
            kind: "meetup-state-unchanged",
            reason: "already-cancelled",
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
        const changed =
          request.action === "unpublish"
            ? await meetups.unpublish(
                request.identity,
                request.meetupId,
                rpcMeta(request),
              )
            : await meetups.cancel(
                request.identity,
                request.meetupId,
                rpcMeta(request),
              );
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
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(value.day)}.${pad(value.month)}.${value.year} ${pad(value.hours)}:${pad(value.minutes)}`;
}

export type { Person };
