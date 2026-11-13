import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { MeetupResult, Meetups } from "../meetups/port.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

type OrganizersRequest = Extract<
  ExecuteRequest,
  { intent: "change-meetup-organizers" }
>;

// Состав организаторов (ADR-076, п. 6). Команды заданы целевым состоянием, а
// решение человека — кого назначить или снять — от остальных полей сходки не
// зависит. Поэтому версия берётся у снимка, прочитанного перед командой, а не
// у экрана: правка названия между экраном и кнопкой назначение не отменяет.
// Конфликт остаётся только у гонки двух команд и показывается текущим
// составом.
export function createMeetupOrganizers(
  meetups: Pick<
    Meetups,
    "get" | "appointOrganizer" | "dismissOrganizer" | "leaveOrganizers"
  >,
) {
  return async (request: OrganizersRequest): Promise<ExecuteResult> => {
    const meta = rpcMeta(request);
    const current = await meetups.get(request.identity, request.meetupId, meta);
    if (current.kind === "not-found") return { kind: "meetup-not-found" };
    if (current.kind !== "ok") return failure(current);
    const change = request.change;
    const result =
      change.kind === "appoint"
        ? await meetups.appointOrganizer(
            request.identity,
            current.meetup,
            change.identityId,
            meta,
          )
        : change.kind === "dismiss"
          ? await meetups.dismissOrganizer(
              request.identity,
              current.meetup,
              change.identityId,
              meta,
            )
          : await meetups.leaveOrganizers(
              request.identity,
              current.meetup,
              meta,
            );
    if (result.kind === "ok") {
      return {
        kind: "organizers-changed",
        meetup: result.meetup,
        change: change.kind,
        changed: !sameRoster(
          current.meetup.organizers,
          result.meetup.organizers,
        ),
      };
    }
    if (result.kind === "conflict") {
      const fresh = await meetups.get(request.identity, request.meetupId, meta);
      if (fresh.kind === "ok")
        return { kind: "conflict", meetup: fresh.meetup };
      if (fresh.kind === "not-found") return { kind: "meetup-not-found" };
      return failure(fresh);
    }
    return failure(result);
  };
}

function failure(result: Exclude<MeetupResult, { kind: "ok" }>): ExecuteResult {
  if (result.kind === "invalid") {
    return {
      kind: "dependency-rejected",
      reason: "invalid",
      cause: result.cause,
      ...(result.precondition ? { precondition: true as const } : {}),
    };
  }
  return { kind: "dependency-rejected", reason: result.kind };
}

function sameRoster(before: readonly string[], after: readonly string[]) {
  return (
    before.length === after.length &&
    before.every((identityId, index) => after[index] === identityId)
  );
}
