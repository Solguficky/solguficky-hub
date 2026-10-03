import type { MeetupResult, Meetups } from "../meetups/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

type MaterialRequest = Extract<
  ExecuteRequest,
  { intent: "attach-material" | "remove-material" }
>;

export function createMeetupMaterials(
  meetups: Pick<Meetups, "attachMaterial" | "removeMaterial" | "get">,
) {
  return async (request: MaterialRequest): Promise<ExecuteResult> => {
    const meta = rpcMeta(request);
    const result =
      request.intent === "attach-material"
        ? await meetups.attachMaterial({
            person: request.identity,
            meetupId: request.meetupId,
            material: request.material,
            expectedVersion: request.expectedVersion,
            ...(meta === undefined ? {} : { meta }),
          })
        : await meetups.removeMaterial({
            person: request.identity,
            meetupId: request.meetupId,
            materialId: request.materialId,
            expectedVersion: request.expectedVersion,
            ...(meta === undefined ? {} : { meta }),
          });
    if (result.kind === "ok") {
      return {
        kind:
          request.intent === "attach-material"
            ? "material-attached"
            : "material-removed",
        meetup: result.meetup,
      };
    }
    if (result.kind === "conflict") {
      // Карточка, по которой человек решал, устарела. Команда не применена и
      // сама не повторяется: человеку показывают текущий снимок, и его версию
      // понесёт кнопка повторного подтверждения (PER-78, PER-393).
      const fresh = await meetups.get(request.identity, request.meetupId, meta);
      if (fresh.kind === "ok")
        return { kind: "conflict", meetup: fresh.meetup };
      // Сходку скрыли или удалили между нажатием и перечитыванием: это тот же
      // исход, что у просмотра, а не сбой зависимости.
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
