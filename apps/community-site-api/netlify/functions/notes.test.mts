// Слой 1: граница HTTP-функции `notes.mts`. Проверяются маршрут, коды
// ответов и обращение к хранилищу — решения о ревизиях и версиях уже
// покрыты `src/document.test.ts` и здесь не повторяются.
import type { Context } from "@netlify/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesDocument } from "../../src/document.js";
import handler from "./notes.mjs";

// `@netlify/blobs` подменяется общим хранилищем поверх `Map`. `vi.hoisted`
// нужен, потому что `vi.mock` поднимается над импортами: без него фабрика
// мока не увидела бы переменные, объявленные ниже.
const { blobs, getSpy, setJSONSpy, getStoreMock, getDeployStoreMock } =
  vi.hoisted(() => {
    const blobs = new Map<string, unknown>();
    // Хранит структурные копии, а не ссылки: иначе тест на «в хранилище
    // осталась чужая запись» мог бы пройти по общему объекту, а не по факту
    // записи.
    const getSpy = vi.fn(async (key: string) =>
      blobs.has(key) ? structuredClone(blobs.get(key)) : null,
    );
    const setJSONSpy = vi.fn(async (key: string, value: unknown) => {
      blobs.set(key, structuredClone(value));
      return { modified: true };
    });
    const store = { get: getSpy, setJSON: setJSONSpy };
    return {
      blobs,
      getSpy,
      setJSONSpy,
      getStoreMock: vi.fn(() => store),
      getDeployStoreMock: vi.fn(() => store),
    };
  });

vi.mock("@netlify/blobs", () => ({
  getStore: getStoreMock,
  getDeployStore: getDeployStoreMock,
}));

const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE = "http://localhost/api/notes";

interface ErrorBody {
  readonly error: string;
  readonly current?: NotesDocument;
}

/** `deploy` отсутствует по умолчанию: так ведёт себя превью и ветка, а не
 *  продакшен. Тесты, которым важен продакшен, передают контекст явно. */
const fakeContext = (deployContext?: string): Context =>
  ({
    deploy:
      deployContext === undefined ? undefined : { context: deployContext },
  }) as unknown as Context;

const req = (method: string, path: string, body?: unknown): Request => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`${BASE}${path}`, init);
};

const call = (
  method: string,
  path: string,
  body?: unknown,
  context: Context = fakeContext(),
): Promise<Response> => handler(req(method, path, body), context);

const createDoc = async (state?: unknown): Promise<NotesDocument> => {
  const response = await call(
    "POST",
    "",
    state === undefined ? undefined : { state },
  );
  return (await response.json()) as NotesDocument;
};

beforeEach(() => {
  blobs.clear();
  getSpy.mockClear();
  setJSONSpy.mockClear();
  getStoreMock.mockClear();
  getDeployStoreMock.mockClear();
  // Путь 500-й ошибки логирует её через console.error нарочно — подавляем
  // только вывод, само поведение тестами ниже проверяется.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("создание", () => {
  it("создаёт документ без тела с начальной версией и валидным идентификатором", async () => {
    const response = await call("POST", "");
    expect(response.status).toBe(201);
    const document = (await response.json()) as NotesDocument;
    expect(document.revision).toBe(1);
    expect(document.versions).toHaveLength(1);
    expect(document.versions[0]?.label).toBe("Начальная версия");
    expect(document.docId).toMatch(DOC_ID_PATTERN);
  });

  it("принимает присланное состояние, отбрасывая в нём неизвестные поля", async () => {
    const response = await call("POST", "", {
      state: { answers: { a: "текст" }, somethingNew: 42 },
    });
    expect(response.status).toBe(201);
    const document = (await response.json()) as NotesDocument;
    expect(document.state).toEqual({
      slots: {},
      answers: { a: "текст" },
      priorities: [],
    });
  });

  it("отвергает состояние неподходящей формы и не пишет запись в хранилище", async () => {
    const response = await call("POST", "", {
      state: { priorities: "строка" },
    });
    expect(response.status).toBe(400);
    expect(blobs.size).toBe(0);
  });

  it("выдаёт разные идентификаторы двум подряд идущим документам", async () => {
    const first = await createDoc();
    const second = await createDoc();
    expect(first.docId).not.toBe(second.docId);
  });
});

describe("чтение", () => {
  it("отдаёт документ целиком вместе с версиями", async () => {
    const created = await createDoc({ answers: { a: "текст" } });
    const response = await call("GET", `/${created.docId}`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as NotesDocument;
    expect(document).toEqual(created);
  });

  it("отказывает в чтении отсутствующего документа с валидной формой идентификатора", async () => {
    const missingId = "A".repeat(22);
    const response = await call("GET", `/${missingId}`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe("Документ не найден");
  });

  it("отказывает по форме идентификатора раньше, чем обращается к хранилищу", async () => {
    const malformed = ["short", "x".repeat(23), `${"x".repeat(21)}!`];
    for (const docId of malformed) {
      const response = await call("GET", `/${docId}`);
      expect(response.status).toBe(404);
    }
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("запись состояния", () => {
  it("поднимает ревизию при совпавшем baseRevision, не трогая число версий", async () => {
    const created = await createDoc();
    const response = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: { a: "правка" } },
    });
    expect(response.status).toBe(200);
    const document = (await response.json()) as NotesDocument;
    expect(document.revision).toBe(created.revision + 1);
    expect(document.versions).toHaveLength(created.versions.length);
  });

  it("отказывает записи поверх чужой, отдавая актуальный документ, и не теряет чужую запись в хранилище", async () => {
    const created = await createDoc();
    const foreign = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: { a: "чужая правка" } },
    }).then((response) => response.json() as Promise<NotesDocument>);

    const response = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: { a: "моя правка" } },
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorBody;
    expect(body.current?.state.answers["a"]).toBe("чужая правка");
    expect((blobs.get(created.docId) as NotesDocument).state.answers["a"]).toBe(
      foreign.state.answers["a"],
    );
  });

  it("отвергает baseRevision, не являющийся неотрицательным целым числом", async () => {
    const created = await createDoc();
    for (const baseRevision of [1.5, -1]) {
      const response = await call("PUT", `/${created.docId}`, {
        baseRevision,
        state: { answers: {} },
      });
      expect(response.status).toBe(400);
    }
  });

  it("отвергает запись без состояния", async () => {
    const created = await createDoc();
    const response = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
    });
    expect(response.status).toBe(400);
  });
});

describe("версии и откат", () => {
  it("добавляет версию с подписью из label", async () => {
    const created = await createDoc();
    const response = await call("POST", `/${created.docId}/versions`, {
      baseRevision: created.revision,
      label: "Перед обсуждением",
    });
    expect(response.status).toBe(200);
    const document = (await response.json()) as NotesDocument;
    expect(document.versions.at(-1)?.label).toBe("Перед обсуждением");
  });

  it("подписывает версию «Без подписи», когда label отсутствует, пуст или состоит из пробелов", async () => {
    const created = await createDoc();
    let revision = created.revision;
    for (const label of [undefined, "", "   "]) {
      const response = await call("POST", `/${created.docId}/versions`, {
        baseRevision: revision,
        label,
      });
      const document = (await response.json()) as NotesDocument;
      expect(document.versions.at(-1)?.label).toBe("Без подписи");
      revision = document.revision;
    }
  });

  it("обрезает слишком длинный label и отвергает label не строкой", async () => {
    const created = await createDoc();
    const long = await call("POST", `/${created.docId}/versions`, {
      baseRevision: created.revision,
      label: "я".repeat(200),
    });
    const document = (await long.json()) as NotesDocument;
    expect(document.versions.at(-1)?.label).toHaveLength(120);

    const notString = await call("POST", `/${created.docId}/versions`, {
      baseRevision: document.revision,
      label: 42,
    });
    expect(notString.status).toBe(400);
  });

  it("отказывает фиксации версии с устаревшим baseRevision", async () => {
    const created = await createDoc();
    const response = await call("POST", `/${created.docId}/versions`, {
      baseRevision: created.revision - 1,
      label: "Опоздавшая фиксация",
    });
    expect(response.status).toBe(409);
  });

  it("возвращает состояние существующей версии, добавляя новую версию с restoredFrom", async () => {
    const created = await createDoc({ answers: { a: "исходное" } });
    const written = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: { a: "правка" } },
    }).then((response) => response.json() as Promise<NotesDocument>);

    const response = await call("POST", `/${created.docId}/restore`, {
      baseRevision: written.revision,
      version: 1,
    });
    expect(response.status).toBe(200);
    const document = (await response.json()) as NotesDocument;
    expect(document.state.answers["a"]).toBe("исходное");
    expect(document.versions.at(-1)?.restoredFrom).toBe(1);
  });

  it("отказывает возврату к несуществующему номеру версии", async () => {
    const created = await createDoc();
    const response = await call("POST", `/${created.docId}/restore`, {
      baseRevision: created.revision,
      version: 99,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe("Версия не найдена");
  });

  it("отвергает version, не являющийся целым числом", async () => {
    const created = await createDoc();
    for (const version of ["1", 1.5, undefined]) {
      const response = await call("POST", `/${created.docId}/restore`, {
        baseRevision: created.revision,
        version,
      });
      expect(response.status).toBe(400);
    }
  });

  it("отказывает возврату с устаревшим baseRevision", async () => {
    const created = await createDoc();
    const response = await call("POST", `/${created.docId}/restore`, {
      baseRevision: created.revision - 1,
      version: 1,
    });
    expect(response.status).toBe(409);
  });
});

describe("маршрут и методы", () => {
  it("отвергает методы, не предусмотренные маршрутом", async () => {
    const created = await createDoc();
    expect((await call("GET", "")).status).toBe(405);
    expect((await call("DELETE", `/${created.docId}`)).status).toBe(405);
    expect((await call("GET", `/${created.docId}/versions`)).status).toBe(405);
  });

  it("отвергает неизвестное действие над документом", async () => {
    const created = await createDoc();
    const response = await call(
      "POST",
      `/${created.docId}/неизвестное-действие`,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe("Неизвестное действие");
  });
});

describe("недоверенный вход", () => {
  it("отвергает тело, которое не разбирается как JSON", async () => {
    const response = await call("POST", "", "{не json");
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe("Тело запроса не разобралось как JSON");
  });

  it("отвергает тело, разобравшееся не в объект", async () => {
    for (const raw of ["[1,2]", '"строка"']) {
      const response = await call("POST", "", raw);
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.error).toBe("Ожидался объект JSON");
    }
  });

  it("отвергает тело больше предела размера ещё до разбора JSON", async () => {
    const oversized = "x".repeat(600 * 1024 + 1);
    const response = await call("POST", "", oversized);
    expect(response.status).toBe(400);
  });

  it("отвергает состояние, раздувающее документ свыше предела, и не портит сохранённое", async () => {
    const created = await createDoc({ answers: { a: "исходное" } });
    // 135 ответов по 4000 однобайтовых символов — заведомо больше предела
    // документа (512 КиБ), но ещё в пределах предела запроса (600 КиБ):
    // случай проверяет именно лимит документа, а не лимит тела из кейса 24.
    const answers = Object.fromEntries(
      Array.from({ length: 135 }, (_, index) => [
        `note-${index}`,
        "x".repeat(4000),
      ]),
    );
    const response = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe("Документ превысил предел размера");
    expect((blobs.get(created.docId) as NotesDocument).state.answers["a"]).toBe(
      "исходное",
    );
  });

  it("считает испорченный блоб отказом сервера, а не ошибкой клиента", async () => {
    // Клиент такого не присылал: испорчена запись в хранилище. Ответ `4xx`
    // спрятал бы инцидент за отказом ввода, поэтому разбор блоба отделён от
    // разбора тела запроса и уходит в общий путь пятисотки.
    const docId = "B".repeat(22);
    blobs.set(docId, "совсем не документ");
    const toGarbageString = await call("GET", `/${docId}`);
    expect(toGarbageString.status).toBe(500);
    expect(await toGarbageString.json()).toEqual({
      error: "Внутренняя ошибка",
    });

    const otherDocId = "C".repeat(22);
    blobs.set(otherDocId, { docId: otherDocId, state: { answers: [] } });
    const toWrongShape = await call("GET", `/${otherDocId}`);
    expect(toWrongShape.status).toBe(500);

    // Пишем в лог, а не в ответ: наружу не уходит ни содержимое записи, ни
    // причина разбора.
    expect(console.error).toHaveBeenCalled();
  });

  it("отказывается работать с документом, чей идентификатор не совпал с ключом", async () => {
    // Запись идёт по идентификатору из самого документа. Если под ключом лежит
    // чужой документ, правка уехала бы под его ключ, запрошенный остался бы
    // нетронутым, а клиент получил бы на это `200` — молчаливая потеря.
    const key = "D".repeat(22);
    const foreign = "E".repeat(22);
    const created = await createDoc();
    blobs.set(key, { ...created, docId: foreign });

    const read = await call("GET", `/${key}`);
    expect(read.status).toBe(500);
    expect(await read.json()).toEqual({ error: "Внутренняя ошибка" });

    const write = await call("PUT", `/${key}`, {
      baseRevision: 1,
      state: { answers: { "n-1": "правка" } },
    });
    expect(write.status).toBe(500);
    // Чужой ключ не тронут: запись до него не дошла.
    expect(blobs.get(foreign)).toBeUndefined();
  });
});

describe("секреты и заголовки", () => {
  it("не выдаёт текст неожиданной ошибки хранилища, отвечая общей 500", async () => {
    const created = await createDoc();
    getSpy.mockImplementationOnce(() => {
      throw new Error("секретная строка соединения с базой");
    });
    const response = await call("GET", `/${created.docId}`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("секретная строка соединения");
    expect(JSON.parse(text)).toEqual({ error: "Внутренняя ошибка" });
  });

  it("не упоминает идентификатор документа в текстах сообщений об ошибке", async () => {
    const created = await createDoc();
    await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: {} },
    });
    const conflict = await call("PUT", `/${created.docId}`, {
      baseRevision: created.revision,
      state: { answers: {} },
    });
    // На 409 в теле есть `current` — весь актуальный документ, и его
    // `docId` неизбежно совпадает с запрошенным: клиент и так знает этот
    // идентификатор из адреса. Норматив («идентификатор не участвует в
    // сообщениях об ошибках») проверяется по полю `error`, а не по всему
    // телу.
    const conflictBody = (await conflict.json()) as ErrorBody;
    expect(conflictBody.error).not.toContain(created.docId);

    const missingId = "D".repeat(22);
    const notFound = await call("GET", `/${missingId}`);
    expect(await notFound.text()).not.toContain(missingId);

    getSpy.mockImplementationOnce(() => {
      throw new Error("сбой");
    });
    const internal = await call("GET", `/${created.docId}`);
    expect(await internal.text()).not.toContain(created.docId);
  });

  it("несёт корректные content-type и cache-control на успешном ответе", async () => {
    const response = await call("POST", "");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("выбор хранилища", () => {
  it("пишет в глобальный store только для продакшен-контекста деплоя", async () => {
    await call("POST", "", undefined, fakeContext("production"));
    expect(getStoreMock).toHaveBeenCalledWith({
      name: "auction-notes",
      consistency: "strong",
    });
    expect(getDeployStoreMock).not.toHaveBeenCalled();
  });

  it("пишет в store деплоя для любого контекста, отличного от продакшена, включая его отсутствие", async () => {
    await call("POST", "", undefined, fakeContext("deploy-preview"));
    await call("POST", "", undefined, fakeContext());
    expect(getDeployStoreMock).toHaveBeenCalledTimes(2);
    expect(getDeployStoreMock).toHaveBeenCalledWith({
      name: "auction-notes",
      consistency: "strong",
    });
    expect(getStoreMock).not.toHaveBeenCalled();
  });
});
