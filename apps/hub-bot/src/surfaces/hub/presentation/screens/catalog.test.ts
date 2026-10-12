import { describe, expect, it } from "vitest";
import {
  inspectCatalog,
  type ScreenEntry,
} from "../../../../../testkit/screen-lint.js";
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

  // Корень один — меню, общий родитель разделов, которые открывают команды
  // (PER-592); цепочку родителей до него держит `inspectCatalog`.
  it("roots the tree in the menu over the sections the commands open", () => {
    const roots = entries
      .filter(([, entry]) => entry.nav === "root")
      .map(([id]) => id);
    const sections = entries
      .filter(([, entry]) => entry.parent === "menu")
      .map(([id]) => id);

    expect(roots).toEqual(["menu"]);
    expect(sections).toEqual(["meetups", "settings", "help", "manage"]);
    expect(inspectCatalog("hub")).toEqual([]);
  });

  it("does not hang a parent on a message that is not a tree screen", () => {
    const stray = entries
      .filter(([, entry]) => entry.nav !== "tree" && entry.parent !== undefined)
      .map(([id]) => id);

    expect(stray).toEqual([]);
  });
});
