import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Loaded } from "./config.js";
import type { Surface } from "./surface.js";

// Записи «Что нового» (ADR-069, п. 1): одно видимое людям изменение — один
// файл `<id>.txt` в каталоге `release-notes/` пакета. Первая строка —
// поверхности (`hub`, `auction` или обе через пробел), затем пустая строка и
// текст для людей. Форму текста задаёт дизайн-код, раздел «Что нового», а
// правило «PR с видимым изменением несёт запись» — норматив
// docs/standards/git/release-notes.md. Один разбор держит и тест пакета, и
// старт процесса: запись, которую отверг бы тест, образ не запустит.

const noteSurfaces = ["hub", "auction"] as const;

export type NoteSurface = (typeof noteSurfaces)[number];

const isNoteSurface = (value: string): value is NoteSurface =>
  noteSurfaces.some((surface) => surface === value);

export type ReleaseNote = {
  id: string;
  surfaces: readonly NoteSurface[];
  text: string;
};

// Что процесс отдаёт поверхности: набор идентификаторов для регистрации в
// Notifications и текст записи по идентификатору для сводки и поста.
export type ReleaseNotes = {
  idsFor(surface: Surface): readonly string[];
  textOf(surface: Surface, id: string): string | undefined;
};

export const maxTextLength = 300;
const maxLines = 3;
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const maxIdLength = 64;

// Нарушения формы текста записи; пустой список — запись годится. Длина — в
// кодовых точках, как её видит человек, а не в единицах UTF-16.
export function checkText(text: string): string[] {
  const violations: string[] = [];
  const length = [...text].length;
  if (length === 0) violations.push("text is empty");
  if (length > maxTextLength) {
    violations.push(`text is ${length} characters, limit ${maxTextLength}`);
  }
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    violations.push(`text has more than ${maxLines} lines`);
  }
  // В сводке запись — строка «• текст»: пустая строка внутри её разорвала бы.
  if (lines.some((line) => line.trim() === "")) {
    violations.push("text has an empty line");
  }
  if (/\b[A-Za-z]+-\d+\b/.test(text)) violations.push("text names a task code");
  if (text.includes("`")) violations.push("text has a code span");
  for (const token of text.split(/\s+/)) {
    // Путь — слеш между символами слова в латинском токене: «a/b»,
    // «src\core». Команда «/menu» и дроби «1/2», «24/7» путём не считаются.
    if (/[\w.-][/\\][\w.-]/.test(token) && /[A-Za-z]/.test(token)) {
      violations.push(`text names a path: ${token}`);
    }
  }
  // Латинский идентификатор — по форме, а не по словарю: «FAQ» и «Telegram»
  // обычные слова интерфейса, а `snake_case`, `camelCase`, `a.b` и латиница
  // с цифрами — следы кода. Точка в конце — конец предложения.
  for (const raw of text.match(/[A-Za-z0-9_.]*[A-Za-z][A-Za-z0-9_.]*/g) ?? []) {
    const token = raw.replace(/\.+$/, "");
    if (/[_.\d]/.test(token) || /[a-z][A-Z]/.test(token)) {
      violations.push(`text names a Latin identifier: ${token}`);
    }
  }
  return violations;
}

// Разбор одного файла: `id` — имя файла без `.txt`.
export function parseNote(id: string, content: string): Loaded<ReleaseNote> {
  const fail = (error: string): Loaded<ReleaseNote> => ({
    ok: false,
    error: `release note ${id}: ${error}`,
  });
  if (!idPattern.test(id) || id.length > maxIdLength) {
    return fail(
      `name must match ${idPattern.source} and fit ${maxIdLength} characters`,
    );
  }
  // CRLF приезжает из рабочего дерева Windows с core.autocrlf.
  const [head = "", gap, ...body] = content.replace(/\r\n/g, "\n").split("\n");
  if (gap !== "") {
    return fail("the surfaces line must be followed by an empty line");
  }
  const named = head.trim().split(/\s+/);
  const surfaces = named.filter(isNoteSurface);
  if (
    surfaces.length !== named.length ||
    new Set(surfaces).size !== surfaces.length
  ) {
    return fail("the first line must be hub, auction or both");
  }
  const text = body.join("\n").trim();
  const violations = checkText(text);
  if (violations.length > 0) return fail(violations.join("; "));
  return { ok: true, config: { id, surfaces, text } };
}

// Каталог записей лежит в корне пакета: рядом с `package.json` и в исходниках
// (`src/core`), и в сборке (`dist/src/core`), и в образе (`/app`). Глубина у
// этих мест разная, поэтому корень ищется подъёмом, а не числом `..`.
export function releaseNotesDirectory(
  from: string = import.meta.dirname,
): string {
  let dir = from;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(from, "release-notes");
    dir = parent;
  }
  return path.join(dir, "release-notes");
}

export function readNoteFiles(directory: string): Loaded<ReleaseNote[]> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return {
      ok: false,
      error: `release notes directory ${directory} is unreadable`,
    };
  }
  const notes: ReleaseNote[] = [];
  for (const name of entries.sort()) {
    // Скрытый файл вроде `.gitkeep` — не запись; запись с точкой в начале
    // имени отвергает шаблон идентификатора ниже.
    if (name.startsWith(".") && !name.endsWith(".txt")) continue;
    if (!name.endsWith(".txt")) {
      return { ok: false, error: `release note ${name}: must be a .txt file` };
    }
    let content: string;
    try {
      content = readFileSync(path.join(directory, name), "utf8");
    } catch {
      return { ok: false, error: `release note ${name}: is unreadable` };
    }
    const parsed = parseNote(name.slice(0, -".txt".length), content);
    if (!parsed.ok) return parsed;
    notes.push(parsed.config);
  }
  return { ok: true, config: notes };
}

export function noteCatalog(notes: readonly ReleaseNote[]): ReleaseNotes {
  const has = (note: ReleaseNote, surface: Surface) =>
    note.surfaces.some((own) => own === surface);
  return {
    idsFor: (surface) =>
      notes.filter((note) => has(note, surface)).map((note) => note.id),
    textOf: (surface, id) =>
      notes.find((note) => note.id === id && has(note, surface))?.text,
  };
}

// Записи образа при старте процесса. Битый или пропавший каталог — отказ
// старта: урезанный набор Notifications приняла бы за выпуск без записей.
export function readReleaseNotes(
  directory: string = releaseNotesDirectory(),
): Loaded<ReleaseNotes> {
  const files = readNoteFiles(directory);
  return files.ok ? { ok: true, config: noteCatalog(files.config) } : files;
}
