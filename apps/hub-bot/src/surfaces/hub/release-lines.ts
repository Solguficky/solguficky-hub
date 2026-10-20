import type { ReleaseNotes } from "../../core/release-notes.js";

export const releaseTraceLimit = 10;

export function knownReleaseLines(
  notes: ReleaseNotes,
  recordIds: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const id of recordIds) {
    const text = notes.textOf("hub", id);
    if (text !== undefined && text !== "") lines.push(text);
  }
  return lines;
}

export type ReleaseTrace = {
  kind: "release-note";
  day: string;
  lines: readonly string[];
  hidden: number;
  summaryId: string;
};

export function toReleaseTrace(
  notes: ReleaseNotes,
  recordIds: readonly string[],
  summaryId: string,
  day: string,
): { kind: "ineligible" } | { kind: "ready"; message: ReleaseTrace } {
  const lines = knownReleaseLines(notes, recordIds);
  if (lines.length === 0) return { kind: "ineligible" };
  const shown = lines.slice(0, releaseTraceLimit);
  return {
    kind: "ready",
    message: {
      kind: "release-note",
      day,
      lines: shown,
      hidden: lines.length - shown.length,
      summaryId,
    },
  };
}
