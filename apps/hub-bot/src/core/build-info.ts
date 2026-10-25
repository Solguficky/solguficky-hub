import { existsSync, readFileSync } from "node:fs";
import type { Loaded } from "./config.js";
import { packageEntry } from "./package-root.js";

// Данные сборки образа (PER-736): короткий коммит и дата коммита, из которого
// CI собрал образ. Их передают аргументы сборки, а `Containerfile` кладёт файлом
// `build-info` в корень пакета, рядом с записями «Что нового» (ADR-069, п. 1):
// строки `commit=<коммит>` и `date=<ГГГГ-ММ-ДД>`. Переменной среды у версии
// нет: values её не знают, и образ сам говорит, из чего он собран.

export type BuildInfo =
  | { kind: "image"; commit: string; date: string }
  | { kind: "local" };

export const localBuild: BuildInfo = { kind: "local" };

const commitPattern = /^[0-9a-f]{7,40}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

// Разбор файла. Оба значения пустые — образ собран без аргументов, это та же
// локальная сборка; одно без другого или чужая форма — образ собран неверно.
export function parseBuildInfo(content: string): Loaded<BuildInfo> {
  const values = new Map<string, string>();
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    if (at < 0) return { ok: false, error: "build info: a line has no '='" };
    values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const commit = values.get("commit") ?? "";
  const date = values.get("date") ?? "";
  if (commit === "" && date === "") return { ok: true, config: localBuild };
  if (!commitPattern.test(commit)) {
    return { ok: false, error: "build info: commit must be a hex commit id" };
  }
  if (!datePattern.test(date)) {
    return { ok: false, error: "build info: date must be YYYY-MM-DD" };
  }
  return { ok: true, config: { kind: "image", commit, date } };
}

// Файла нет — локальный запуск или тест: это не отказ.
export function readBuildInfo(
  file: string = packageEntry("build-info"),
): Loaded<BuildInfo> {
  if (!existsSync(file)) return { ok: true, config: localBuild };
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: `build info ${file} is unreadable` };
  }
  return parseBuildInfo(content);
}

// Версия процесса для записи о старте и `service.version` OTLP: коммит образа
// или `local`.
export function buildVersion(build: BuildInfo): string {
  return build.kind === "image" ? build.commit : "local";
}
