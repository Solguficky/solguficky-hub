import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVersion,
  localBuild,
  parseBuildInfo,
  readBuildInfo,
} from "./build-info.js";

function fileWith(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "build-info-"));
  const file = path.join(dir, "build-info");
  writeFileSync(file, content);
  return file;
}

describe("build info", () => {
  it("reads the commit and date the image was built from", () => {
    const loaded = readBuildInfo(fileWith("commit=d78d99f\ndate=2026-10-25\n"));
    expect(loaded).toEqual({
      ok: true,
      config: { kind: "image", commit: "d78d99f", date: "2026-10-25" },
    });
    expect(loaded.ok && buildVersion(loaded.config)).toBe("d78d99f");
  });

  // Локальный запуск и тесты: файла нет, и это не отказ.
  it("is a local build without the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "build-info-"));
    expect(readBuildInfo(path.join(dir, "build-info"))).toEqual({
      ok: true,
      config: localBuild,
    });
    expect(buildVersion(localBuild)).toBe("local");
  });

  it("is a local build from an image built without the arguments", () => {
    expect(parseBuildInfo("commit=\ndate=\n")).toEqual({
      ok: true,
      config: localBuild,
    });
  });

  it("is a local build in the source tree", () => {
    expect(readBuildInfo()).toEqual({ ok: true, config: localBuild });
  });

  it.each([
    ["commit=d78d99f\ndate=\n", "date"],
    ["commit=\ndate=2026-10-25\n", "commit"],
    ["commit=HEAD\ndate=2026-10-25\n", "commit"],
    ["commit=d78d99f\ndate=25.10.2026\n", "date"],
    ["d78d99f\n", "'='"],
  ])("refuses %j", (content, named) => {
    const parsed = parseBuildInfo(content);
    expect(parsed.ok ? "" : parsed.error).toContain(named);
  });
});
