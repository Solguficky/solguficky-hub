import type { ReleaseNotes } from "../../../core/release-notes.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  NotificationFailure,
  Notifications,
  ReleaseSummaryNeighbours,
} from "../notifications/port.js";
import { knownReleaseLines } from "../release-lines.js";
import type { ExecuteResult, ReleaseNotesRequest } from "./types.js";

const pageSize = 10;
const hopLimit = 100;

type Loaded = ReleaseSummaryNeighbours;

type Read =
  | { kind: "ok"; view: Loaded }
  | { kind: "missing" }
  | { kind: "failed"; failure: NotificationFailure };

export type ReleaseNotesView = (
  request: ReleaseNotesRequest,
) => Promise<ExecuteResult>;

export function createReleaseNotes(
  notifications: Notifications,
  notes: ReleaseNotes,
): ReleaseNotesView {
  const linesOf = (recordIds: readonly string[]) =>
    knownReleaseLines(notes, recordIds);

  const read = async (
    summaryId: string,
    request: ReleaseNotesRequest,
  ): Promise<Read> => {
    const result = await notifications.getReleaseSummary(
      summaryId,
      rpcMeta(request),
    );
    if (result.kind === "not-found") return { kind: "missing" };
    if (result.kind !== "ok") return { kind: "failed", failure: result };
    return { kind: "ok", view: result.view };
  };

  const firstKnown = async (
    startId: string | undefined,
    direction: "older" | "newer",
    request: ReleaseNotesRequest,
    seen: Set<string>,
  ): Promise<
    | { kind: "known"; view: Loaded }
    | { kind: "none" }
    | { kind: "failed"; failure: NotificationFailure }
  > => {
    let current = startId;
    for (let hop = 0; hop < hopLimit && current !== undefined; hop += 1) {
      if (seen.has(current)) return { kind: "none" };
      seen.add(current);
      const loaded = await read(current, request);
      if (loaded.kind === "failed") return loaded;
      if (loaded.kind === "missing") return { kind: "none" };
      if (linesOf(loaded.view.summary.recordIds).length > 0) {
        return { kind: "known", view: loaded.view };
      }
      current =
        direction === "older" ? loaded.view.olderId : loaded.view.newerId;
    }
    return { kind: "none" };
  };

  const target = async (
    startId: string | undefined,
    direction: "older" | "newer",
    request: ReleaseNotesRequest,
    seen: Set<string>,
  ): Promise<
    | { kind: "arrow"; target?: { summaryId: string; part: number } }
    | { kind: "failed"; failure: NotificationFailure }
  > => {
    const found = await firstKnown(startId, direction, request, seen);
    if (found.kind === "failed") return found;
    if (found.kind !== "known") return { kind: "arrow" };
    return {
      kind: "arrow",
      target: { summaryId: found.view.summary.id, part: 1 },
    };
  };

  const present = async (
    view: Loaded,
    requestedPart: number | undefined,
    request: ReleaseNotesRequest,
  ): Promise<ExecuteResult> => {
    const lines = linesOf(view.summary.recordIds);
    if (lines.length === 0) {
      const seen = new Set([view.summary.id]);
      const older = await firstKnown(view.olderId, "older", request, seen);
      if (older.kind === "failed") return rejection(older.failure);
      if (older.kind === "known") return present(older.view, 1, request);
      const newer = await firstKnown(view.newerId, "newer", request, seen);
      if (newer.kind === "failed") return rejection(newer.failure);
      if (newer.kind === "known") return present(newer.view, 1, request);
      return { kind: "release-empty" };
    }
    const partCount = Math.ceil(lines.length / pageSize);
    const part =
      requestedPart !== undefined &&
      requestedPart >= 1 &&
      requestedPart <= partCount
        ? requestedPart
        : 1;
    const seen = new Set([view.summary.id]);
    const older =
      part > 1
        ? {
            kind: "arrow" as const,
            target: { summaryId: view.summary.id, part: part - 1 },
          }
        : await target(view.olderId, "older", request, seen);
    if (older.kind === "failed") return rejection(older.failure);
    const newer =
      part < partCount
        ? {
            kind: "arrow" as const,
            target: { summaryId: view.summary.id, part: part + 1 },
          }
        : await target(view.newerId, "newer", request, new Set(seen));
    if (newer.kind === "failed") return rejection(newer.failure);
    return {
      kind: "release-post",
      summaryId: view.summary.id,
      summarizedAt: view.summary.summarizedAt,
      lines: lines.slice((part - 1) * pageSize, part * pageSize),
      part,
      partCount,
      ...(older.target === undefined ? {} : { older: older.target }),
      ...(newer.target === undefined ? {} : { newer: newer.target }),
    };
  };

  const latest = async (
    request: ReleaseNotesRequest,
  ): Promise<ExecuteResult> => {
    let pageToken: string | undefined;
    const seenPages = new Set<string>();
    for (let page = 0; page < hopLimit; page += 1) {
      const listed = await notifications.listReleaseSummaries(
        pageToken,
        rpcMeta(request),
      );
      if (listed.kind !== "ok") return rejection(listed);
      for (const summary of listed.page.summaries) {
        if (linesOf(summary.recordIds).length === 0) continue;
        const loaded = await read(summary.id, request);
        if (loaded.kind === "failed") return rejection(loaded.failure);
        if (
          loaded.kind === "ok" &&
          linesOf(loaded.view.summary.recordIds).length > 0
        ) {
          return present(loaded.view, request.part, request);
        }
      }
      const next = listed.page.nextPageToken;
      if (next === undefined || seenPages.has(next)) {
        return { kind: "release-empty" };
      }
      seenPages.add(next);
      pageToken = next;
    }
    return { kind: "release-empty" };
  };

  return async (request) => {
    if (request.summaryId === undefined) return latest(request);
    const loaded = await read(request.summaryId, request);
    if (loaded.kind === "failed") return rejection(loaded.failure);
    if (loaded.kind === "missing") return latest(request);
    return present(loaded.view, request.part, request);
  };
}

function rejection(failure: NotificationFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? {
        kind: "dependency-rejected",
        reason: "invalid",
        cause: failure.cause,
      }
    : { kind: "dependency-rejected", reason: failure.kind };
}
