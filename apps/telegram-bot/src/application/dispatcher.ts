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
