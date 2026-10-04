import { describe, expect, it } from "vitest";
import type { ScreenEntry } from "../../../testkit/screen-lint.js";
import { meetupListParent, meetupLists, screenCatalog } from "./catalog.js";

const entries: [string, ScreenEntry][] = Object.entries(screenCatalog);

describe("screen catalog", () => {
  it("gives every tree screen a parent that children can name", () => {
    const orphans = entries
      .filter(([, entry]) => entry.nav === "tree")
      .filter(([, entry]) => {
        const parents: readonly string[] =
          entry.parent === meetupListParent
            ? meetupLists
            : [entry.parent ?? ""];
        return !parents.every(
          (parent) =>
            (screenCatalog as Record<string, ScreenEntry>)[parent]?.backName !==
            undefined,
        );
      })
      .map(([id]) => id);

    expect(orphans).toEqual([]);
  });

  it("keeps the tree rooted in the menu alone", () => {
    const roots = entries
      .filter(([, entry]) => entry.nav === "root")
      .map(([id]) => id);

    expect(roots).toEqual(["menu"]);
  });

  it("does not hang a parent on a message that is not a tree screen", () => {
    const stray = entries
      .filter(([, entry]) => entry.nav !== "tree" && entry.parent !== undefined)
      .map(([id]) => id);

    expect(stray).toEqual([]);
  });
});
