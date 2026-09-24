import type { Meetups } from "../meetups/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

type MaterialRequest = Extract<
  ExecuteRequest,
  { intent: "attach-material" | "remove-material" }
>;

export function createMeetupMaterials(
  meetups: Pick<Meetups, "attachMaterial" | "removeMaterial">,
) {
  return async (request: MaterialRequest): Promise<ExecuteResult> => {
    const meta = rpcMeta(request);
    const result =
      request.intent === "attach-material"
        ? await meetups.attachMaterial({
            person: request.identity,
            meetupId: request.meetupId,
            material: request.material,
            ...(meta === undefined ? {} : { meta }),
          })
        : await meetups.removeMaterial({
            person: request.identity,
            meetupId: request.meetupId,
            materialId: request.materialId,
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
    if (result.kind === "invalid") {
      return {
        kind: "dependency-rejected",
        reason: "invalid",
        message: result.message,
      };
    }
    return { kind: "dependency-rejected", reason: result.kind };
  };
}
