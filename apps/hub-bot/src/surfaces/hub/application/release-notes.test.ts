import { describe, expect, it, vi } from "vitest";
import { noteCatalog } from "../../../core/release-notes.js";
import type { Notifications } from "../notifications/port.js";
import { createReleaseNotes } from "./release-notes.js";
import type { Person } from "./types.js";

const person: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub"],
};
const latestId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
const olderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
const unknownOnlyId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3403";

const notes = noteCatalog([
  {
    id: "known",
    surfaces: ["hub"],
    text: "Под сводкой аукциона теперь кнопка на каждый лот.",
  },
  {
    id: "second",
    surfaces: ["hub"],
    text: "Закрытый лот больше нельзя добавить в избранное.",
  },
  { id: "auction-only", surfaces: ["auction"], text: "Только аукцион." },
]);

function notifications(overrides: Partial<Notifications>): Notifications {
  return {
    getGlobalPreferences: vi.fn(),
    getMeetupPreferences: vi.fn(),
    setSubscription: vi.fn(),
    setGlobalCategory: vi.fn(),
    setMeetupCategory: vi.fn(),
    getAuctionNotifications: vi.fn(),
    setAuctionNotifications: vi.fn(),
    broadcastToMeetupSubscribers: vi.fn(),
    broadcastToCommunity: vi.fn(),
    reportReleaseNotes: vi.fn(),
    listReleaseSummaries: vi.fn(),
    getReleaseSummary: vi.fn(),
    ...overrides,
  } as Notifications;
}

describe("release notes post", () => {
  it("opens the latest summary the image knows and skips an unknown record", async () => {
    const view = createReleaseNotes(
      notifications({
        listReleaseSummaries: vi.fn().mockResolvedValue({
          kind: "ok",
          page: {
            summaries: [
              {
                id: unknownOnlyId,
                summarizedAt: "2026-10-15T00:00:00Z",
                recordIds: ["missing"],
              },
              {
                id: latestId,
                summarizedAt: "2026-10-14T00:00:00Z",
                recordIds: ["missing", "known", "auction-only"],
              },
            ],
          },
        }),
        getReleaseSummary: vi.fn(async (summaryId: string) => {
          if (summaryId === olderId) {
            return {
              kind: "ok" as const,
              view: {
                summary: {
                  id: olderId,
                  summarizedAt: "2026-10-13T00:00:00Z",
                  recordIds: ["second"],
                },
                newerId: latestId,
              },
            };
          }
          return {
            kind: "ok" as const,
            view: {
              summary: {
                id: latestId,
                summarizedAt: "2026-10-14T00:00:00Z",
                recordIds: ["missing", "known", "auction-only"],
              },
              olderId,
            },
          };
        }),
      }),
      notes,
    );

    await expect(
      view({ identity: person, intent: "view-release-notes" }),
    ).resolves.toMatchObject({
      kind: "release-post",
      summaryId: latestId,
      lines: ["Под сводкой аукциона теперь кнопка на каждый лот."],
      part: 1,
      partCount: 1,
      older: { summaryId: olderId, part: 1 },
    });
  });

  it("is empty when no summary has a record the image knows", async () => {
    const view = createReleaseNotes(
      notifications({
        listReleaseSummaries: vi.fn().mockResolvedValue({
          kind: "ok",
          page: {
            summaries: [
              {
                id: unknownOnlyId,
                summarizedAt: "2026-10-14T00:00:00Z",
                recordIds: ["missing"],
              },
            ],
          },
        }),
      }),
      notes,
    );

    await expect(
      view({ identity: person, intent: "view-release-notes" }),
    ).resolves.toEqual({ kind: "release-empty" });
  });

  it("splits a long summary into parts and keeps the latest without a newer page", async () => {
    const recordIds = Array.from({ length: 11 }, (_, index) => `line-${index}`);
    const longNotes = noteCatalog(
      recordIds.map((id) => ({
        id,
        surfaces: ["hub" as const],
        text: `Строка ${id}.`,
      })),
    );
    const summary = {
      id: latestId,
      summarizedAt: "2026-10-14T00:00:00Z",
      recordIds,
    };
    const getReleaseSummary = vi.fn().mockResolvedValue({
      kind: "ok",
      view: { summary },
    });
    const view = createReleaseNotes(
      notifications({
        listReleaseSummaries: vi.fn().mockResolvedValue({
          kind: "ok",
          page: { summaries: [summary] },
        }),
        getReleaseSummary,
      }),
      longNotes,
    );

    const first = await view({
      identity: person,
      intent: "view-release-notes",
    });
    expect(first).toMatchObject({
      kind: "release-post",
      part: 1,
      partCount: 2,
      newer: { summaryId: latestId, part: 2 },
    });
    if (first.kind !== "release-post") return;
    expect(first.lines).toHaveLength(10);

    await expect(
      view({
        identity: person,
        intent: "view-release-notes",
        summaryId: latestId,
        part: 2,
      }),
    ).resolves.toMatchObject({
      kind: "release-post",
      part: 2,
      partCount: 2,
      lines: ["Строка line-10."],
      older: { summaryId: latestId, part: 1 },
    });
  });

  it("opens the first part when the requested part is gone", async () => {
    const view = createReleaseNotes(
      notifications({
        getReleaseSummary: vi.fn().mockResolvedValue({
          kind: "ok",
          view: {
            summary: {
              id: latestId,
              summarizedAt: "2026-10-14T00:00:00Z",
              recordIds: ["known"],
            },
          },
        }),
      }),
      notes,
    );

    await expect(
      view({
        identity: person,
        intent: "view-release-notes",
        summaryId: latestId,
        part: 4,
      }),
    ).resolves.toMatchObject({ part: 1, partCount: 1 });
  });

  it("reports a notifications failure instead of an empty post", async () => {
    const view = createReleaseNotes(
      notifications({
        listReleaseSummaries: vi.fn().mockResolvedValue({
          kind: "unavailable",
          cause: new Error("unimplemented"),
        }),
      }),
      notes,
    );

    await expect(
      view({ identity: person, intent: "view-release-notes" }),
    ).resolves.toMatchObject({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
  });
});
