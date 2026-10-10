import { describe, expect, it } from "vitest";
import type { ScreenEntry } from "../../../../../testkit/screen-lint.js";
import {
  auctionFeedParent,
  auctionFeedParents,
  manageParents,
  meetupListParent,
  meetupLists,
  screenCatalog,
} from "./catalog.js";

const entries: [string, ScreenEntry][] = Object.entries(screenCatalog);

describe("screen catalog", () => {
  it("gives every tree screen a parent that children can name", () => {
    const orphans = entries
      .filter(([, entry]) => entry.nav === "tree")
      .filter(([, entry]) => {
        const groups: Readonly<Record<string, readonly string[]>> = {
          [meetupListParent]: meetupLists,
          [auctionFeedParent]: auctionFeedParents,
          ...manageParents,
        };
        const parents: readonly string[] = groups[entry.parent ?? ""] ?? [
          entry.parent ?? "",
        ];
        return !parents.every(
          (parent) =>
            (screenCatalog as Record<string, ScreenEntry>)[parent]?.backName !==
            undefined,
        );
      })
      .map(([id]) => id);

    expect(orphans).toEqual([]);
  });

  // Решение владельца 10 октября 2026 года: корня «Меню» нет, корни — разделы,
  // которые открывают команды.
  it("roots the tree in the sections the commands open", () => {
    const roots = entries
      .filter(([, entry]) => entry.nav === "root")
      .map(([id]) => id);

    expect(roots).toEqual(["meetups", "settings", "help", "manage"]);
  });

  it("does not hang a parent on a message that is not a tree screen", () => {
    const stray = entries
      .filter(([, entry]) => entry.nav !== "tree" && entry.parent !== undefined)
      .map(([id]) => id);

    expect(stray).toEqual([]);
  });
});
