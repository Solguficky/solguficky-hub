import type {
  MeetupSchedule,
  MeetupSnapshot,
  Meetups,
} from "../meetups/port.js";
import type { ExecuteRequest, ExecuteResult, Person } from "./types.js";

export function createMeetupForm(meetups: Meetups) {
  return async (
    request: Exclude<ExecuteRequest, { intent: "start" }>,
  ): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "create-meetup":
        return map(
          await meetups.createDraft(
            request.identity,
            request.meetupId,
            request.requestId,
          ),
          "title",
        );
      case "set-meetup-field": {
        const current = await meetups.get(
          request.identity,
          request.meetupId,
          request.requestId,
        );
        if (current.kind !== "ok") return failure(current);
        if (request.field === "schedule") {
          const schedule = parseSchedule(request.value);
          if (schedule === undefined) {
            return {
              kind: "ask",
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
            request.requestId,
          );
          if (scheduled.kind === "invalid") {
            return invalidField(
              request.field,
              current.meetup,
              scheduled.message,
            );
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
          request.requestId,
        );
        if (updated.kind === "invalid") {
          return invalidField(request.field, current.meetup, updated.message);
        }
        return map(updated, next);
      }
      case "publish-meetup":
        return mapPublished(
          await meetups.publish(
            request.identity,
            request.meetupId,
            request.requestId,
          ),
        );
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
  field: Exclude<
    ExecuteRequest,
    { intent: "start" | "create-meetup" | "publish-meetup" }
  >["field"],
  meetup: MeetupSnapshot,
  message: string,
): ExecuteResult {
  return {
    kind: "ask",
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
