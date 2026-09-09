import { describe, expect, it } from "vitest";
import type { Meetups } from "../meetups/port.js";
import { createDispatcher } from "./dispatcher.js";

describe("dispatcher", () => {
  it("renders the start response without telegram types", async () => {
    const dispatcher = createDispatcher();
    const result = await dispatcher.execute({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "start",
    });
    expect(result).toEqual({
      kind: "message",
      text: expect.stringContaining("Привет."),
    });
  });

  it("renders the same start response when a deep link is present", async () => {
    const dispatcher = createDispatcher();
    const result = await dispatcher.execute({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "start",
      deepLink: {
        kind: "meetup",
        payload: "m_AZLzpLXGfY6fChssPU5fYA",
      },
    });
    expect(result).toEqual({
      kind: "message",
      text: expect.stringContaining("Привет."),
    });
  });

  it("returns exactly the visible list supplied by Meetups", async () => {
    const listVisible = async () => ({
      kind: "ok" as const,
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Настолки",
        },
      ],
    });
    const notUsed = async (): Promise<never> => {
      throw new Error("not used");
    };
    const meetups: Meetups = {
      listVisible,
      createDraft: notUsed,
      get: notUsed,
      changeAttributes: notUsed,
      setSchedule: notUsed,
      publish: notUsed,
    };
    const dispatcher = createDispatcher(meetups);

    await expect(
      dispatcher.execute({
        identity: {
          identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
          globalRoles: [],
        },
        intent: "list-visible-meetups",
      }),
    ).resolves.toEqual({
      kind: "meetup-list",
      meetups: [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
          title: "Настолки",
        },
      ],
    });
  });

  it("returns the same result for a hidden and a missing meetup", async () => {
    const notUsed = async (): Promise<never> => {
      throw new Error("not used");
    };
    for (const failure of [
      { kind: "not-found" },
      { kind: "forbidden" },
    ] as const) {
      const meetups: Meetups = {
        listVisible: notUsed,
        createDraft: notUsed,
        get: async () => failure,
        changeAttributes: notUsed,
        setSchedule: notUsed,
        publish: notUsed,
      };
      await expect(
        createDispatcher(meetups).execute({
          identity: {
            identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            globalRoles: [],
          },
          intent: "view-meetup",
          meetupId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
        }),
      ).resolves.toEqual({ kind: "meetup-not-found" });
    }
  });
});
