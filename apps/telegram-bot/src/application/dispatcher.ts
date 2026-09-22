import type { Meetups } from "../meetups/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import { createMeetupForm } from "./meetup-form.js";
import { createMeetupMaterials } from "./meetup-materials.js";
import { start } from "./start.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

export type Dispatcher = {
  execute(request: ExecuteRequest): ExecuteResult | Promise<ExecuteResult>;
};

export function createDispatcher(meetups?: Meetups): Dispatcher {
  const form = meetups === undefined ? undefined : createMeetupForm(meetups);
  const materials =
    meetups === undefined ? undefined : createMeetupMaterials(meetups);
  return {
    async execute(request) {
      switch (request.intent) {
        case "start":
          return start(request);
        case "list-visible-meetups": {
          if (meetups === undefined) {
            return { kind: "rejected", reason: "meetups-not-configured" };
          }
          const result = await meetups.listVisible(
            request.identity,
            rpcMeta(request),
          );
          return result.kind === "ok"
            ? { kind: "meetup-list", meetups: result.meetups }
            : result.kind === "invalid"
              ? {
                  kind: "dependency-rejected",
                  reason: "invalid",
                  message: result.message,
                }
              : { kind: "dependency-rejected", reason: result.kind };
        }
        case "view-meetup": {
          if (meetups === undefined)
            return { kind: "rejected", reason: "meetups-not-configured" };
          const result = await meetups.get(
            request.identity,
            request.meetupId,
            rpcMeta(request),
          );
          if (result.kind === "ok")
            return { kind: "meetup-card", meetup: result.meetup };
          if (result.kind === "not-found") return { kind: "meetup-not-found" };
          return result.kind === "invalid"
            ? {
                kind: "dependency-rejected",
                reason: "invalid",
                message: result.message,
              }
            : { kind: "dependency-rejected", reason: result.kind };
        }
        case "create-meetup":
        case "set-meetup-field":
        case "update-meetup-field":
        case "publish-meetup":
        case "change-meetup-state":
          return form === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : form(request);
        case "attach-material":
        case "remove-material":
          return materials === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : materials(request);
        default: {
          const _exhaustive: never = request;
          return { kind: "rejected", reason: String(_exhaustive) };
        }
      }
    },
  };
}
