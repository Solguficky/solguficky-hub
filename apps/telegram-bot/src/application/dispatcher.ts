import type { Meetups } from "../meetups/port.js";
import { createMeetupForm } from "./meetup-form.js";
import { start } from "./start.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

export type Dispatcher = {
  execute(request: ExecuteRequest): ExecuteResult | Promise<ExecuteResult>;
};

export function createDispatcher(meetups?: Meetups): Dispatcher {
  const form = meetups === undefined ? undefined : createMeetupForm(meetups);
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
            request.requestId,
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
        case "create-meetup":
        case "set-meetup-field":
        case "publish-meetup":
          return form === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : form(request);
      }
    },
  };
}
