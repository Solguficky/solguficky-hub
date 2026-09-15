// Документ заметок страницы «Аукцион 2026»: текущее состояние плюс история
// зафиксированных версий. Модуль чистый: ни Netlify, ни сети, ни времени из
// воздуха — момент всегда приходит аргументом. Так история и откаты
// проверяются обычными тестами, без эмулятора платформы.

/** Формат документа. Растёт, когда меняется форма `NotesState`. */
export const SCHEMA_VERSION = 1;

/** Больше версий не храним: старые вытесняются записью новой. */
export const MAX_VERSIONS = 40;

/** Предел сериализованного документа. Blobs держат и гигабайты, но документ
 *  целиком ездит в каждом ответе, и распухший блоб бьёт по странице, а не по
 *  хранилищу. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

const MAX_ANSWER_LENGTH = 4000;
const MAX_ANSWERS = 500;
const MAX_SLOTS = 500;
const MAX_PRIORITIES = 100;
const MAX_PRIORITY_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;
const MAX_KEY_LENGTH = 200;

/** Оценки важности и сложности фичи. Значения здесь не перечислены: их состав
 *  задаёт разметка страницы, и сервер не обязан ходить за ней следом. */
export interface SlotValues {
  readonly [kind: string]: string;
}

export interface NotesState {
  readonly slots: { readonly [featureId: string]: SlotValues };
  readonly answers: { readonly [noteId: string]: string };
  readonly priorities: readonly string[];
}

export interface NotesVersion {
  readonly number: number;
  readonly at: string;
  readonly label: string;
  readonly state: NotesState;
  /** Номер версии, из которой эта получена откатом. */
  readonly restoredFrom?: number;
}

export interface NotesDocument {
  readonly schema: number;
  readonly docId: string;
  /** Счётчик записей состояния. Клиент присылает его как `baseRevision`, и
   *  расхождение означает, что кто-то успел записать раньше. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: NotesState;
  readonly versions: readonly NotesVersion[];
}

export class ValidationError extends Error {}

/** Запись отклонена, потому что документ ушёл вперёд. Несёт актуальный
 *  документ: клиенту нужно показать расхождение, а не просто отказ. */
export class ConflictError extends Error {
  // Поле объявлено явно, а не параметром конструктора: сокращение TypeScript
  // требует настоящей компиляции, а этот модуль должен читаться и рантаймами,
  // которые типы только срезают.
  readonly current: NotesDocument;

  constructor(message: string, current: NotesDocument) {
    super(message);
    this.current = current;
  }
}

export const emptyState = (): NotesState => ({
  slots: {},
  answers: {},
  priorities: [],
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Чтение поля недоверенного объекта. Через переменную, а не точкой: точечный
 *  доступ к index signature запрещён `noPropertyAccessFromIndexSignature`, а
 *  скобочный с литералом — правилом линтера. Хелпер снимает спор обоих. */
const pick = (source: Record<string, unknown>, name: string): unknown =>
  source[name];

const requireKey = (key: string, where: string): void => {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`${where}: недопустимый идентификатор`);
  }
};

const parseSlots = (raw: unknown): NotesState["slots"] => {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new ValidationError("slots: ожидался объект");
  const entries = Object.entries(raw);
  if (entries.length > MAX_SLOTS)
    throw new ValidationError("slots: слишком много записей");
  const slots: Record<string, Record<string, string>> = {};
  for (const [featureId, value] of entries) {
    requireKey(featureId, "slots");
    if (!isPlainObject(value))
      throw new ValidationError("slots: ожидался объект оценок");
    const kinds: Record<string, string> = {};
    for (const [kind, selected] of Object.entries(value)) {
      requireKey(kind, "slots");
      if (typeof selected !== "string")
        throw new ValidationError("slots: ожидалась строка");
      if (selected.length > MAX_KEY_LENGTH)
        throw new ValidationError("slots: слишком длинное значение");
      kinds[kind] = selected;
    }
    slots[featureId] = kinds;
  }
  return slots;
};

const parseAnswers = (raw: unknown): NotesState["answers"] => {
  if (raw === undefined) return {};
  if (!isPlainObject(raw))
    throw new ValidationError("answers: ожидался объект");
  const entries = Object.entries(raw);
  if (entries.length > MAX_ANSWERS)
    throw new ValidationError("answers: слишком много записей");
  const answers: Record<string, string> = {};
  for (const [noteId, text] of entries) {
    requireKey(noteId, "answers");
    if (typeof text !== "string")
      throw new ValidationError("answers: ожидалась строка");
    if (text.length > MAX_ANSWER_LENGTH)
      throw new ValidationError("answers: слишком длинный ответ");
    answers[noteId] = text;
  }
  return answers;
};

const parsePriorities = (raw: unknown): NotesState["priorities"] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new ValidationError("priorities: ожидался массив");
  if (raw.length > MAX_PRIORITIES)
    throw new ValidationError("priorities: слишком много пунктов");
  return raw.map((item) => {
    if (typeof item !== "string")
      throw new ValidationError("priorities: ожидалась строка");
    if (item.length > MAX_PRIORITY_LENGTH)
      throw new ValidationError("priorities: слишком длинный пункт");
    return item;
  });
};

/** Разбор недоверенного состояния. Форма страницы меняется чаще, чем формат
 *  хранения, поэтому неизвестные поля отбрасываются, а не роняют запись. */
export const parseState = (raw: unknown): NotesState => {
  if (!isPlainObject(raw)) throw new ValidationError("state: ожидался объект");
  return {
    slots: parseSlots(pick(raw, "slots")),
    answers: parseAnswers(pick(raw, "answers")),
    priorities: parsePriorities(pick(raw, "priorities")),
  };
};

export const parseLabel = (raw: unknown, fallback: string): string => {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string")
    throw new ValidationError("label: ожидалась строка");
  const label = raw.trim().slice(0, MAX_LABEL_LENGTH);
  return label.length > 0 ? label : fallback;
};

export const parseRevision = (raw: unknown): number => {
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw new ValidationError("baseRevision: ожидалось целое число");
  }
  return raw as number;
};

/** Сериализованный размер документа. Проверяется до записи: отказ по лимиту
 *  должен наступать раньше, чем хранилище примет распухший блоб. */
export const assertFits = (document: NotesDocument): NotesDocument => {
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new ValidationError("Документ превысил предел размера");
  }
  return document;
};

/** Значение поля, если оно нужного типа, иначе запасное. Разбор блоба обязан
 *  пережить и документ прошлого формата, и чужой JSON под тем же ключом. */
const text = (
  source: Record<string, unknown>,
  name: string,
  fallback: string,
): string => {
  const value = pick(source, name);
  return typeof value === "string" ? value : fallback;
};

const count = (
  source: Record<string, unknown>,
  name: string,
  fallback: number,
): number => {
  const value = pick(source, name);
  return typeof value === "number" ? value : fallback;
};

const epoch = new Date(0).toISOString();

const parseVersion = (raw: unknown, index: number): NotesVersion => {
  if (!isPlainObject(raw))
    throw new ValidationError("versions: ожидался объект");
  const restoredFrom = pick(raw, "restoredFrom");
  return {
    number: count(raw, "number", index + 1),
    at: text(raw, "at", epoch),
    label: text(raw, "label", "Без подписи"),
    state: parseState(pick(raw, "state")),
    ...(typeof restoredFrom === "number" ? { restoredFrom } : {}),
  };
};

/** Разбор документа из хранилища. Чужой или испорченный JSON в блобе не должен
 *  выглядеть как пустой документ: такое лечится отказом, а не молчанием. */
export const parseDocument = (raw: unknown): NotesDocument => {
  if (!isPlainObject(raw))
    throw new ValidationError("document: ожидался объект");
  const versions = pick(raw, "versions");
  return {
    schema: count(raw, "schema", SCHEMA_VERSION),
    docId: text(raw, "docId", ""),
    revision: count(raw, "revision", 0),
    createdAt: text(raw, "createdAt", epoch),
    updatedAt: text(raw, "updatedAt", epoch),
    state: parseState(pick(raw, "state")),
    versions: Array.isArray(versions) ? versions.map(parseVersion) : [],
  };
};

const nextVersionNumber = (document: NotesDocument): number =>
  document.versions.reduce((max, version) => Math.max(max, version.number), 0) +
  1;

const withVersion = (
  document: NotesDocument,
  version: NotesVersion,
): readonly NotesVersion[] =>
  [...document.versions, version].slice(-MAX_VERSIONS);

const requireBase = (document: NotesDocument, baseRevision: number): void => {
  if (document.revision !== baseRevision) {
    throw new ConflictError(
      "Документ изменился: перечитайте и повторите",
      document,
    );
  }
};

export const createDocument = (
  docId: string,
  state: NotesState,
  at: string,
): NotesDocument =>
  assertFits({
    schema: SCHEMA_VERSION,
    docId,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    state,
    versions: [{ number: 1, at, label: "Начальная версия", state }],
  });

/** Автосохранение: состояние заменяется, история не растёт. Версии копятся
 *  только по явному действию читателя — иначе список версий превращается в
 *  журнал нажатий клавиш и перестаёт быть историей. */
export const writeState = (
  document: NotesDocument,
  state: NotesState,
  baseRevision: number,
  at: string,
): NotesDocument => {
  requireBase(document, baseRevision);
  return assertFits({
    ...document,
    revision: document.revision + 1,
    updatedAt: at,
    state,
  });
};

/** Явная фиксация версии. Снимок берётся с текущего состояния документа, а не
 *  из запроса: фиксируется то, что на сервере, и подпись не может разъехаться
 *  с содержимым. */
export const addVersion = (
  document: NotesDocument,
  label: string,
  baseRevision: number,
  at: string,
): NotesDocument => {
  requireBase(document, baseRevision);
  const version: NotesVersion = {
    number: nextVersionNumber(document),
    at,
    label,
    state: document.state,
  };
  return assertFits({
    ...document,
    revision: document.revision + 1,
    updatedAt: at,
    versions: withVersion(document, version),
  });
};

/** Откат вперёд: содержимое старой версии становится текущим состоянием и
 *  одновременно новой версией. Ничего не удаляется, поэтому ошибочный откат
 *  откатывается тем же действием. */
export const restoreVersion = (
  document: NotesDocument,
  versionNumber: number,
  baseRevision: number,
  at: string,
): NotesDocument => {
  requireBase(document, baseRevision);
  const source = document.versions.find(
    (version) => version.number === versionNumber,
  );
  if (!source) throw new ValidationError("Версия не найдена");
  const version: NotesVersion = {
    number: nextVersionNumber(document),
    at,
    label: `Откат к версии ${source.number}`,
    state: source.state,
    restoredFrom: source.number,
  };
  return assertFits({
    ...document,
    revision: document.revision + 1,
    updatedAt: at,
    state: source.state,
    versions: withVersion(document, version),
  });
};
