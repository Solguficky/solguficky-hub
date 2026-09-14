// HTTP-граница документа заметок «Аукциона 2026». Здесь живут маршрут, коды
// ответа и хранилище; решения о ревизиях и откатах принимает `src/document.ts`.
//
// Логина нет по условию задачи. Пропуском служит сам идентификатор документа:
// 128 случайных бит в адресе, который знают только те, кому его передали.
// Поэтому идентификатор не выводится в логи и не участвует в сообщениях об
// ошибках.
import { getDeployStore, getStore, type Store } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import {
  addVersion,
  ConflictError,
  createDocument,
  emptyState,
  type NotesDocument,
  parseDocument,
  parseLabel,
  parseRevision,
  parseState,
  restoreVersion,
  ValidationError,
  writeState,
} from "../../src/document.js";

const STORE_NAME = "auction-notes";
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_REQUEST_BYTES = 600 * 1024;

// Blobs по умолчанию eventually consistent: запись видна не сразу. Для
// документа, который читают и сразу пишут дальше, это дало бы откат к
// вчерашнему состоянию на ровном месте.
const storeOptions = { name: STORE_NAME, consistency: "strong" } as const;

/** Продакшен пишет в глобальный store, превью и ветки — в свой, привязанный к
 *  деплою. Иначе проверочный документ лёг бы рядом с рабочим. */
const openStore = (context: Context): Store =>
  context.deploy?.context === "production"
    ? getStore(storeOptions)
    : getDeployStore(storeOptions);

const newDocId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString("base64url");
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const fail = (status: number, message: string): Response =>
  json({ error: message }, status);

/** Поля запроса объявлены целиком недоверенными: разбирает их `src/document.ts`,
 *  а здесь они только доезжают до него. */
interface RequestBody {
  state?: unknown;
  baseRevision?: unknown;
  label?: unknown;
  version?: unknown;
}

const readBody = async (request: Request): Promise<RequestBody> => {
  const text = await request.text();
  if (text.length === 0) return {};
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new ValidationError("Запрос превысил предел размера");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ValidationError("Ожидался объект JSON");
    }
    return parsed as RequestBody;
  } catch (error) {
    throw error instanceof ValidationError
      ? error
      : new ValidationError("Тело запроса не разобралось как JSON");
  }
};

const load = async (
  store: Store,
  docId: string,
): Promise<NotesDocument | null> => {
  const raw = await store.get(docId, { type: "json" });
  return raw === null || raw === undefined ? null : parseDocument(raw);
};

const save = async (
  store: Store,
  document: NotesDocument,
): Promise<Response> => {
  await store.setJSON(document.docId, document);
  return json(document);
};

const handleCreate = async (
  store: Store,
  request: Request,
  now: string,
): Promise<Response> => {
  const body = await readBody(request);
  const state =
    body.state === undefined ? emptyState() : parseState(body.state);
  const document = createDocument(newDocId(), state, now);
  await store.setJSON(document.docId, document);
  return json(document, 201);
};

const handleWrite = async (
  store: Store,
  document: NotesDocument,
  request: Request,
  now: string,
): Promise<Response> => {
  const body = await readBody(request);
  const state = parseState(body.state);
  return save(
    store,
    writeState(document, state, parseRevision(body.baseRevision), now),
  );
};

const handleVersion = async (
  store: Store,
  document: NotesDocument,
  request: Request,
  now: string,
): Promise<Response> => {
  const body = await readBody(request);
  const label = parseLabel(body.label, "Без подписи");
  return save(
    store,
    addVersion(document, label, parseRevision(body.baseRevision), now),
  );
};

const handleRestore = async (
  store: Store,
  document: NotesDocument,
  request: Request,
  now: string,
): Promise<Response> => {
  const body = await readBody(request);
  const { version } = body;
  if (!Number.isInteger(version))
    throw new ValidationError("version: ожидалось целое число");
  return save(
    store,
    restoreVersion(
      document,
      version as number,
      parseRevision(body.baseRevision),
      now,
    ),
  );
};

export default async (
  request: Request,
  context: Context,
): Promise<Response> => {
  const segments = new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .slice(2);
  const [docId, action] = segments;
  const store = openStore(context);
  const now = new Date().toISOString();

  try {
    if (docId === undefined) {
      return request.method === "POST"
        ? await handleCreate(store, request, now)
        : fail(405, "Метод не поддерживается");
    }

    if (!DOC_ID_PATTERN.test(docId)) return fail(404, "Документ не найден");

    const document = await load(store, docId);
    if (!document) return fail(404, "Документ не найден");

    if (action === undefined) {
      if (request.method === "GET") return json(document);
      if (request.method === "PUT")
        return await handleWrite(store, document, request, now);
      return fail(405, "Метод не поддерживается");
    }
    if (request.method !== "POST") return fail(405, "Метод не поддерживается");
    if (action === "versions")
      return await handleVersion(store, document, request, now);
    if (action === "restore")
      return await handleRestore(store, document, request, now);
    return fail(404, "Неизвестное действие");
  } catch (error) {
    if (error instanceof ConflictError) {
      return json({ error: error.message, current: error.current }, 409);
    }
    if (error instanceof ValidationError) return fail(400, error.message);
    // Текст неожиданной ошибки наружу не отдаём: он может нести содержимое
    // запроса, а запрос несёт заметки.
    console.error("notes: необработанная ошибка", error);
    return fail(500, "Внутренняя ошибка");
  }
};

export const config: Config = {
  path: ["/api/notes", "/api/notes/:docId", "/api/notes/:docId/:action"],
};
