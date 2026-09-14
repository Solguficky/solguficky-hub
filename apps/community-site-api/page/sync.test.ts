// Слой 2: клиентская логика страницы «Аукцион 2026» — блок синхронизации
// заметок в конце `docs/published/auction-2026/index.html`. Страница
// загружается через `page/load.ts` из настоящего файла и исполняется целиком
// (`runScripts: "dangerously"`), поэтому тест ломается, когда ломается
// опубликованная страница, а не копия для тестов.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  type FetchCall,
  type FetchResult,
  loadAuctionPage,
  makeDocument,
  makeState,
} from "./load.js";

// Каждый кейс грузит и исполняет настоящую страницу заново (jsdom-парсинг,
// инлайновый скрипт, иногда несколько витков debounce) — под нагрузкой это
// не всегда укладывается в дефолтные 5 секунд vitest.
vi.setConfig({ testTimeout: 30_000 });

// Заготовка из разметки: `#priorities` содержит эти пять пунктов, пока их не
// тронул ни читатель, ни сервер.
const DEFAULT_PRIORITIES = [
  "Полноценное участие онлайн",
  "Интерес на протяжении всего события",
  "Сбор средств",
  "Атмосфера живого финала",
  "Удобство участников и организаторов",
];

// Заметка встречается во всех кейсах, где нужен произвольный id: у неё есть
// и текстовое содержимое, и ответное поле — подходит и для answer-теста, и
// для печатной копии.
const NOTE_ID = "n-9950bae3";
const FEATURE_ID = "catalog";
const DOC_ID = "AbCdEfGhIjKlMnOpQrStUv";

const SERVER_PRIORITIES = ["Серверный пункт один", "Серверный пункт два"];
const LOCAL_PRIORITIES = ["Моё, не серверное"];

const $ = <T extends Element = HTMLElement>(
  document: Document,
  selector: string,
): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`элемент не найден: ${selector}`);
  return element;
};

const text = (document: Document, selector: string): string =>
  ($(document, selector).textContent ?? "").trim();

const isHidden = (document: Document, selector: string): boolean =>
  Boolean($<HTMLElement>(document, selector).hidden);

const priorityTexts = (document: Document): string[] =>
  [...document.querySelectorAll("#priorities .t")].map((node) =>
    (node.textContent ?? "").trim(),
  );

const storedJSON = (window: Window, key: string): unknown => {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
};

const bodyOf = (call: FetchCall): Record<string, unknown> =>
  call.body as Record<string, unknown>;

type PageWindow = Window & typeof globalThis;

const changeSelect = (
  window: PageWindow,
  select: HTMLSelectElement,
  value: string,
): void => {
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

const typeInto = (
  window: PageWindow,
  field: HTMLTextAreaElement,
  value: string,
): void => {
  field.value = value;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("старт без сервера", () => {
  it("без документа и локального состояния показывает офлайн-статус и только кнопку включения", async () => {
    const page = loadAuctionPage();
    await page.flush();

    expect(text(page.document, "#sync-state")).toBe("Только в этом браузере");
    expect(isHidden(page.document, "#sync-enable")).toBe(false);
    expect(isHidden(page.document, "#sync-history")).toBe(true);
    expect(isHidden(page.document, "#sync-share")).toBe(true);
  });

  it("правка поля пишется в localStorage немедленно, до и без всякой сети", async () => {
    const page = loadAuctionPage();
    await page.flush();

    const select = $<HTMLSelectElement>(
      page.document,
      `#${FEATURE_ID} select[data-slot="value"]`,
    );
    changeSelect(page.window, select, "Обязательно");

    const stored = storedJSON(page.window, "rfc007-state") as {
      slots: Record<string, Record<string, string>>;
    };
    expect(stored.slots[FEATURE_ID]?.["value"]).toBe("Обязательно");
    expect(page.calls).toHaveLength(0);
  });

  it("переносит поля из трёх прежних ключей при первой загрузке", async () => {
    const page = loadAuctionPage({
      seedLocalStorage: {
        "rfc007-slots": JSON.stringify({
          [FEATURE_ID]: { value: "Хорошо бы" },
        }),
        "rfc007-answers": JSON.stringify({ [NOTE_ID]: "старый ответ" }),
        "rfc007-priorities": JSON.stringify(["Из старого ключа"]),
      },
    });
    await page.flush();

    const select = $<HTMLSelectElement>(
      page.document,
      `#${FEATURE_ID} select[data-slot="value"]`,
    );
    expect(select.value).toBe("Хорошо бы");
    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    expect(textarea.value).toBe("старый ответ");
    expect(priorityTexts(page.document)).toEqual(["Из старого ключа"]);
  });

  // Перенос завершается на загрузке, а не с первой правкой: иначе читатель,
  // который ничего не тронул, продолжает жить на прежних ключах, и заполненное
  // видит только код прежней страницы.
  it("переносит прежние ключи в новый сразу при загрузке, ничего не теряя", async () => {
    const legacy = {
      "rfc007-slots": JSON.stringify({ [FEATURE_ID]: { value: "Хорошо бы" } }),
      "rfc007-answers": JSON.stringify({ [NOTE_ID]: "старый ответ" }),
      "rfc007-priorities": JSON.stringify(["Из старого ключа"]),
    };
    const page = loadAuctionPage({ seedLocalStorage: legacy });
    await page.flush();

    const state = storedJSON(page.window, "rfc007-state") as {
      answers: Record<string, string>;
      slots: Record<string, Record<string, string>>;
      priorities: string[];
    };
    expect(state.answers[NOTE_ID]).toBe("старый ответ");
    expect(state.slots[FEATURE_ID]?.["value"]).toBe("Хорошо бы");
    expect(state.priorities).toEqual(["Из старого ключа"]);
    // Прежние ключи не вычищаются: откат страницы на предыдущую версию без них
    // потерял бы всё, а стоят они ничего.
    for (const [key, value] of Object.entries(legacy)) {
      expect(page.window.localStorage.getItem(key)).toBe(value);
    }
    // Перенос — это запись в браузере, а не повод пойти в сеть.
    expect(page.calls).toHaveLength(0);
  });

  // Обратная сторона переноса: он не должен заводить ключ там, где переносить
  // нечего. Иначе первое же открытие страницы оставляет след в браузере
  // читателя, который ничего не заполнял.
  it("в чистом браузере не заводит ключ состояния вовсе", async () => {
    const page = loadAuctionPage();
    await page.flush();

    expect(storedJSON(page.window, "rfc007-state")).toBeNull();
  });

  it("при обоих ключах побеждает новый", async () => {
    const page = loadAuctionPage({
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({ priorities: ["Новый ключ побеждает"] }),
        ),
        "rfc007-slots": JSON.stringify({
          [FEATURE_ID]: { value: "Хорошо бы" },
        }),
        "rfc007-answers": JSON.stringify({ [NOTE_ID]: "из старого ключа" }),
        "rfc007-priorities": JSON.stringify(["Старый ключ"]),
      },
    });
    await page.flush();

    expect(priorityTexts(page.document)).toEqual(["Новый ключ побеждает"]);
    const select = $<HTMLSelectElement>(
      page.document,
      `#${FEATURE_ID} select[data-slot="value"]`,
    );
    expect(select.value).toBe("");
  });
});

describe("открытие по ссылке", () => {
  it("?doc= в адресе читает документ и убирает параметр, сохраняя прочее", async () => {
    const doc = makeDocument({ docId: DOC_ID });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}&keep=1#section`,
      fetchHandler: (call) =>
        call.method === "GET" ? { body: doc } : { status: 404 },
    });
    await page.flush();

    expect(page.window.location.pathname).toBe("/auction-2026");
    expect(page.window.location.search).toBe("?keep=1");
    expect(page.window.location.hash).toBe("#section");
    expect(page.calls[0]).toMatchObject({ method: "GET", path: `/${DOC_ID}` });
  });

  // Регрессия: заготовка приоритетов приходит из разметки уже заполненной, а
  // не пустым списком. Сравнение локального состояния должно идти со
  // снимком `pristine`, а не с `{priorities: []}` — иначе чистый браузер
  // всегда выглядел бы «своим», и любая чужая ссылка показывала бы развилку.
  it("чистый браузер по чужой ссылке показывает серверное состояние без развилки", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: makeState({ priorities: SERVER_PRIORITIES }),
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) =>
        call.method === "GET" ? { body: doc } : { status: 404 },
    });
    await page.flush();

    expect(isHidden(page.document, "#sync-clash")).toBe(true);
    expect(priorityTexts(page.document)).toEqual(SERVER_PRIORITIES);
    expect(text(page.document, "#sync-state")).toContain(
      "Сохранено на сервере",
    );
  });

  it("свои заметки, отличные от серверных, показывают развилку «Залить мои / Оставить серверные»", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 3,
      state: makeState({ priorities: SERVER_PRIORITIES }),
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({ priorities: LOCAL_PRIORITIES }),
        ),
      },
      fetchHandler: (call) =>
        call.method === "GET" ? { body: doc } : { status: 404 },
    });
    await page.flush();

    expect(isHidden(page.document, "#sync-clash")).toBe(false);
    expect(text(page.document, "#sync-take-theirs")).toBe("Оставить серверные");
    expect(text(page.document, "#sync-take-mine")).toBe("Залить мои");
    expect(text(page.document, "#sync-state")).toBe(
      "Показана серверная версия",
    );
  });

  it("«залить мои» пишет локальное состояние PUT-ом и фиксирует его версией", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 3,
      state: makeState({ priorities: SERVER_PRIORITIES }),
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({ priorities: LOCAL_PRIORITIES }),
        ),
      },
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "PUT") return { body: { ...doc, revision: 4 } };
        if (call.method === "POST" && call.path.endsWith("/versions")) {
          return { body: { ...doc, revision: 5 } };
        }
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-take-mine").click();
    await page.flush();

    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /${DOC_ID}`,
      `PUT /${DOC_ID}`,
      `POST /${DOC_ID}/versions`,
    ]);
    const putBody = bodyOf(page.calls[1] as FetchCall);
    const putState = putBody["state"] as { priorities: string[] };
    expect(putState.priorities).toEqual(LOCAL_PRIORITIES);
    expect(bodyOf(page.calls[2] as FetchCall)["label"]).toBe(
      "Заметки из браузера",
    );
  });

  it("«оставить серверные» не отправляет PUT и оставляет в полях серверное", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 3,
      state: makeState({ priorities: SERVER_PRIORITIES }),
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({ priorities: LOCAL_PRIORITIES }),
        ),
      },
      fetchHandler: (call) =>
        call.method === "GET" ? { body: doc } : { status: 404 },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-take-theirs").click();
    await page.flush();

    expect(page.calls).toHaveLength(1);
    expect(priorityTexts(page.document)).toEqual(SERVER_PRIORITIES);
  });
});

describe("автосохранение и конфликт", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("правка шлёт PUT ровно один раз после истечения debounce, а не на каждый символ", async () => {
    const doc = makeDocument({ docId: DOC_ID, revision: 1 });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "PUT") return { body: { ...doc, revision: 2 } };
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    for (const chunk of ["п", "пр", "при"]) {
      typeInto(page.window, textarea, chunk);
      vi.advanceTimersByTime(400);
      await page.flush();
    }
    expect(page.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

    vi.advanceTimersByTime(1200);
    await page.flush();
    expect(page.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("правка во время незавершённого PUT не шлёт второй запрос параллельно, а повторяет его после завершения первого", async () => {
    const doc = makeDocument({ docId: DOC_ID, revision: 1 });
    const firstPut = deferred<FetchResult>();
    let putCount = 0;
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "PUT") {
          putCount += 1;
          if (putCount === 1) return firstPut.promise;
          return { body: { ...doc, revision: 3 } };
        }
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    typeInto(page.window, textarea, "первая правка");
    vi.advanceTimersByTime(1200);
    await page.flush();
    expect(putCount).toBe(1);

    typeInto(page.window, textarea, "вторая правка поверх первой");
    vi.advanceTimersByTime(1200);
    await page.flush();
    expect(putCount).toBe(1);

    firstPut.resolve({ body: { ...doc, revision: 2 } });
    await page.flush();
    expect(putCount).toBe(2);
  });

  it("конфликт по PUT показывает развилку, и «оставить мою» сначала фиксирует чужую правку", async () => {
    const initialDoc = makeDocument({ docId: DOC_ID, revision: 5 });
    const conflictDoc = makeDocument({
      docId: DOC_ID,
      revision: 6,
      state: makeState({ answers: { [NOTE_ID]: "чужая правка" } }),
    });
    let putAttempts = 0;
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: initialDoc };
        if (call.method === "PUT") {
          putAttempts += 1;
          if (putAttempts === 1) {
            return {
              status: 409,
              body: { error: "конфликт", current: conflictDoc },
            };
          }
          return { body: { ...initialDoc, revision: 8 } };
        }
        if (call.method === "POST" && call.path.endsWith("/versions")) {
          return { body: { ...conflictDoc, revision: 7 } };
        }
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    typeInto(page.window, textarea, "моя правка");
    vi.advanceTimersByTime(1200);
    await page.flush();

    expect(isHidden(page.document, "#sync-clash")).toBe(false);
    expect(text(page.document, "#sync-take-theirs")).toBe("Взять чужую");
    expect(text(page.document, "#sync-take-mine")).toBe("Оставить мою");

    $<HTMLButtonElement>(page.document, "#sync-take-mine").click();
    await page.flush();

    const putCalls = page.calls.filter((call) => call.method === "PUT");
    const versionCalls = page.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/versions"),
    );
    expect(putCalls).toHaveLength(2);
    expect(versionCalls).toHaveLength(1);
    const versionIndex = page.calls.indexOf(versionCalls[0] as FetchCall);
    const retryPutIndex = page.calls.lastIndexOf(putCalls[1] as FetchCall);
    expect(versionIndex).toBeGreaterThan(
      page.calls.indexOf(putCalls[0] as FetchCall),
    );
    expect(versionIndex).toBeLessThan(retryPutIndex);
    expect(bodyOf(versionCalls[0] as FetchCall)["label"]).toBe(
      "Чужая правка перед перезаписью",
    );
  });

  it("404 с телом API при чтении по ссылке возвращает кнопку включения и чистит метаданные", async () => {
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: () => ({
        status: 404,
        body: { error: "Документ не найден" },
      }),
    });
    await page.flush();

    expect(text(page.document, "#sync-state")).toBe(
      "Документ по ссылке не найден, показаны заметки из браузера",
    );
    expect(isHidden(page.document, "#sync-enable")).toBe(false);
    expect(storedJSON(page.window, "rfc007-sync")).toEqual({});
  });

  it("404 без JSON-тела (статика без функции) оставляет заметки браузера и не показывает кнопку включения", async () => {
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({ priorities: LOCAL_PRIORITIES }),
        ),
      },
      fetchHandler: () => ({ status: 404, notJson: true }),
    });
    await page.flush();

    expect(text(page.document, "#sync-state")).toBe(
      "Сервер недоступен, показаны заметки из браузера",
    );
    expect(isHidden(page.document, "#sync-enable")).toBe(true);
    expect(priorityTexts(page.document)).toEqual(LOCAL_PRIORITIES);
  });

  it("отказ fetch при правке сохраняет её в браузере и показывает офлайн-статус", async () => {
    const doc = makeDocument({ docId: DOC_ID, revision: 1 });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        throw new Error("сеть недоступна");
      },
    });
    await page.flush();

    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    typeInto(page.window, textarea, "правка офлайн");
    vi.advanceTimersByTime(1200);
    await page.flush();

    expect(text(page.document, "#sync-state")).toBe(
      "Сервер недоступен, правки лежат в браузере",
    );
    const stored = storedJSON(page.window, "rfc007-state") as {
      answers: Record<string, string>;
    };
    expect(stored.answers[NOTE_ID]).toBe("правка офлайн");
  });
});

describe("действия", () => {
  it("кнопка включения создаёт документ и открывает ссылку с историей", async () => {
    const page = loadAuctionPage();
    await page.flush();

    const newDoc = makeDocument({ docId: DOC_ID, revision: 1 });
    page.setFetchHandler((call) => {
      if (call.method === "POST" && call.path === "")
        return { status: 201, body: newDoc };
      throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
    });

    $<HTMLButtonElement>(page.document, "#sync-enable").click();
    await page.flush();

    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({ method: "POST", path: "" });
    const link = $<HTMLInputElement>(page.document, "#sync-link");
    expect(link.value).toBe(`http://localhost/auction-2026?doc=${DOC_ID}`);
    expect(isHidden(page.document, "#sync-history")).toBe(false);
    expect(isHidden(page.document, "#sync-share")).toBe(false);
    expect(isHidden(page.document, "#sync-enable")).toBe(true);
  });

  it("история: строка на версию, отметка текущей и сводка изменений", async () => {
    const v1State = makeState();
    const v2State = makeState({
      answers: { [NOTE_ID]: "ответ" },
      slots: { [FEATURE_ID]: { value: "Обязательно" } },
      priorities: ["Другой порядок"],
    });
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: v2State,
      versions: [
        {
          number: 1,
          at: "2026-01-01T00:00:00.000Z",
          label: "Начальная версия",
          state: v1State,
        },
        {
          number: 2,
          at: "2026-01-02T00:00:00.000Z",
          label: "Без подписи",
          state: v2State,
        },
      ],
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) =>
        call.method === "GET" ? { body: doc } : { status: 404 },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    const rows = [...page.document.querySelectorAll("#history-list > li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".history-meta")?.textContent).toContain(
      "Начало отсчёта",
    );
    const secondMeta =
      rows[1]?.querySelector(".history-meta")?.textContent ?? "";
    expect(secondMeta).toContain("изменено");
    expect(secondMeta).toContain("заметок: 1");
    expect(secondMeta).toContain("оценок: 1");
    expect(secondMeta).toContain("приоритеты");
    expect(rows[1]?.getAttribute("data-current")).toBe("yes");
    expect(rows[0]?.getAttribute("data-current")).toBeNull();
  });

  it("«вернуть» шлёт restore с номером версии и применяет ответ к полям", async () => {
    const original = makeState({ priorities: ["Исходное"] });
    const current = makeState({ priorities: ["Текущее"] });
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: current,
      versions: [
        {
          number: 1,
          at: "2026-01-01T00:00:00.000Z",
          label: "Начальная версия",
          state: original,
        },
        {
          number: 2,
          at: "2026-01-02T00:00:00.000Z",
          label: "Без подписи",
          state: current,
        },
      ],
    });
    const restored = makeDocument({
      docId: DOC_ID,
      revision: 3,
      state: original,
      versions: [
        ...doc.versions,
        {
          number: 3,
          at: "2026-01-03T00:00:00.000Z",
          label: "Откат к версии 1",
          state: original,
          restoredFrom: 1,
        },
      ],
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "POST" && call.path.endsWith("/restore"))
          return { body: restored };
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    const firstRowButton = page.document.querySelector<HTMLButtonElement>(
      "#history-list li button",
    );
    if (!firstRowButton) throw new Error("кнопка «Вернуть» не найдена");
    firstRowButton.click();
    await page.flush();

    const restoreCall = page.calls.find((call) =>
      call.path.endsWith("/restore"),
    );
    if (!restoreCall) throw new Error("запрос restore не отправлен");
    expect(bodyOf(restoreCall)).toEqual({ baseRevision: 2, version: 1 });
    expect(priorityTexts(page.document)).toEqual(["Исходное"]);
  });

  // Автосохранённое версией не становится, поэтому перед возвратом оно ничем
  // не защищено: возврат перезаписал бы его без следа. Страница снимает его
  // версией сама — так же, как снимает чужую правку в развилке конфликта.
  it("возврат сначала фиксирует несохранённое версией «Состояние перед возвратом»", async () => {
    const original = makeState({ priorities: ["Исходное"] });
    const draft = makeState({
      priorities: ["Черновик, которого нет в истории"],
    });
    const first = {
      number: 1,
      at: "2026-01-01T00:00:00.000Z",
      label: "Начальная версия",
      state: original,
    };
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: draft,
      versions: [first],
    });
    const kept = {
      number: 2,
      at: "2026-01-02T00:00:00.000Z",
      label: "Состояние перед возвратом",
      state: draft,
    };
    const snapshot = makeDocument({
      docId: DOC_ID,
      revision: 3,
      state: draft,
      versions: [first, kept],
    });
    const restored = makeDocument({
      docId: DOC_ID,
      revision: 4,
      state: original,
      versions: [
        first,
        kept,
        {
          number: 3,
          at: "2026-01-03T00:00:00.000Z",
          label: "Откат к версии 1",
          state: original,
          restoredFrom: 1,
        },
      ],
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "POST" && call.path.endsWith("/versions"))
          return { body: snapshot };
        if (call.method === "POST" && call.path.endsWith("/restore"))
          return { body: restored };
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    $<HTMLButtonElement>(page.document, "#history-list li button").click();
    await page.flush();

    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /${DOC_ID}`,
      `POST /${DOC_ID}/versions`,
      `POST /${DOC_ID}/restore`,
    ]);
    expect(bodyOf(page.calls[1] as FetchCall)).toEqual({
      baseRevision: 2,
      label: "Состояние перед возвратом",
    });
    // Возврат опирается на ревизию, которую вернул снимок, а не на прежнюю.
    expect(bodyOf(page.calls[2] as FetchCall)).toEqual({
      baseRevision: 3,
      version: 1,
    });
    expect(priorityTexts(page.document)).toEqual(["Исходное"]);
    // Черновик не пропал: он в истории и его можно вернуть тем же действием.
    expect(text(page.document, "#history-list")).toContain(
      "Состояние перед возвратом",
    );
  });

  it("не плодит снимок, когда текущее состояние и есть последняя версия", async () => {
    const current = makeState({ priorities: ["Текущее"] });
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: current,
      versions: [
        {
          number: 1,
          at: "2026-01-01T00:00:00.000Z",
          label: "Начальная версия",
          state: makeState({ priorities: ["Исходное"] }),
        },
        {
          number: 2,
          at: "2026-01-02T00:00:00.000Z",
          label: "Перед обсуждением",
          state: current,
        },
      ],
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "POST" && call.path.endsWith("/restore"))
          return { body: { ...doc, revision: 3 } };
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    $<HTMLButtonElement>(page.document, "#history-list li button").click();
    await page.flush();

    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /${DOC_ID}`,
      `POST /${DOC_ID}/restore`,
    ]);
  });

  // Снимок — не украшение поверх возврата, а его условие: если сохранить
  // текущее не удалось, возврат не выполняется вовсе. Иначе отказ сети ровно в
  // этот момент означал бы ту самую потерю, от которой снимок и заведён.
  it("отменяет возврат целиком, если снимок сохранить не удалось", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      state: makeState({ priorities: ["Черновик"] }),
      versions: [
        {
          number: 1,
          at: "2026-01-01T00:00:00.000Z",
          label: "Начальная версия",
          state: makeState({ priorities: ["Исходное"] }),
        },
      ],
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "POST" && call.path.endsWith("/versions"))
          return { status: 500, body: { error: "Внутренняя ошибка" } };
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    $<HTMLButtonElement>(page.document, "#history-list li button").click();
    await page.flush();

    expect(page.calls.some((call) => call.path.endsWith("/restore"))).toBe(
      false,
    );
    expect(text(page.document, "#sync-state")).toBe(
      "Возврат отменён: не удалось сохранить текущее состояние",
    );
    expect(priorityTexts(page.document)).toEqual(["Черновик"]);
  });

  it("конфликт при возврате применяет актуальное состояние и не считает возврат выполненным", async () => {
    const doc = makeDocument({
      docId: DOC_ID,
      revision: 2,
      versions: [
        {
          number: 1,
          at: "2026-01-01T00:00:00.000Z",
          label: "Начальная версия",
          state: makeState(),
        },
        {
          number: 2,
          at: "2026-01-02T00:00:00.000Z",
          label: "Без подписи",
          state: makeState(),
        },
      ],
    });
    const current = makeDocument({
      docId: DOC_ID,
      revision: 5,
      state: makeState({ priorities: ["Успели поменять"] }),
    });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "POST" && call.path.endsWith("/restore")) {
          return { status: 409, body: { error: "конфликт", current } };
        }
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    $<HTMLButtonElement>(page.document, "#sync-history").click();
    const button = page.document.querySelector<HTMLButtonElement>(
      "#history-list li button",
    );
    if (!button) throw new Error("кнопка «Вернуть» не найдена");
    button.click();
    await page.flush();

    expect(text(page.document, "#sync-state")).toBe(
      "Документ успели изменить, возврат не выполнен",
    );
    expect(priorityTexts(page.document)).toEqual(["Успели поменять"]);
  });

  it("фиксация версии сначала пишет черновик, потом версию, и чистит поле подписи", async () => {
    const doc = makeDocument({ docId: DOC_ID, revision: 3 });
    const page = loadAuctionPage({
      url: `http://localhost/auction-2026?doc=${DOC_ID}`,
      fetchHandler: (call) => {
        if (call.method === "GET") return { body: doc };
        if (call.method === "PUT") return { body: { ...doc, revision: 4 } };
        if (call.method === "POST" && call.path.endsWith("/versions")) {
          return { body: { ...doc, revision: 5 } };
        }
        throw new Error(`неожиданный запрос ${call.method} ${call.path}`);
      },
    });
    await page.flush();

    const label = $<HTMLInputElement>(page.document, "#history-label");
    label.value = "Перед обсуждением";
    $<HTMLButtonElement>(page.document, "#history-commit").click();
    await page.flush();

    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /${DOC_ID}`,
      `PUT /${DOC_ID}`,
      `POST /${DOC_ID}/versions`,
    ]);
    expect(bodyOf(page.calls.at(-1) as FetchCall)["label"]).toBe(
      "Перед обсуждением",
    );
    expect(label.value).toBe("");
  });

  describe("копирование ссылки", () => {
    it("успешное копирование вызывает clipboard.writeText со ссылкой", async () => {
      const doc = makeDocument({ docId: DOC_ID });
      const page = loadAuctionPage({
        url: `http://localhost/auction-2026?doc=${DOC_ID}`,
        fetchHandler: (call) =>
          call.method === "GET" ? { body: doc } : { status: 404 },
      });
      await page.flush();

      const writeText = vi.fn(async () => {});
      Object.defineProperty(page.window.navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      $<HTMLButtonElement>(page.document, "#sync-share").click();
      await page.flush();

      expect(writeText).toHaveBeenCalledWith(
        `http://localhost/auction-2026?doc=${DOC_ID}`,
      );
    });

    it("отказ буфера обмена не выходит наружу и переносит фокус на поле ссылки", async () => {
      const doc = makeDocument({ docId: DOC_ID });
      const page = loadAuctionPage({
        url: `http://localhost/auction-2026?doc=${DOC_ID}`,
        fetchHandler: (call) =>
          call.method === "GET" ? { body: doc } : { status: 404 },
      });
      await page.flush();

      Object.defineProperty(page.window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("нет доступа к буферу обмена");
          },
        },
      });
      const link = $<HTMLInputElement>(page.document, "#sync-link");
      const focusSpy = vi.spyOn(link, "focus");
      const selectSpy = vi.spyOn(link, "select");

      expect(() =>
        $<HTMLButtonElement>(page.document, "#sync-share").click(),
      ).not.toThrow();
      await page.flush();

      expect(focusSpy).toHaveBeenCalled();
      expect(selectSpy).toHaveBeenCalled();
    });
  });
});

describe("применение состояния", () => {
  it("значение слота вне options не применяется: select остаётся пустым", async () => {
    const page = loadAuctionPage({
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(
          makeState({
            slots: {
              [FEATURE_ID]: { value: "Такого варианта нет в разметке" },
            },
          }),
        ),
      },
    });
    await page.flush();

    const select = $<HTMLSelectElement>(
      page.document,
      `#${FEATURE_ID} select[data-slot="value"]`,
    );
    expect(select.value).toBe("");
  });

  it("пустой список приоритетов в состоянии показывает заготовки из разметки", async () => {
    const page = loadAuctionPage({
      seedLocalStorage: {
        "rfc007-state": JSON.stringify(makeState({ priorities: [] })),
      },
    });
    await page.flush();

    expect(priorityTexts(page.document)).toEqual(DEFAULT_PRIORITIES);
  });

  it("печатные копии заполненного попадают в .slot-print и .answer-print с data-атрибутами", async () => {
    const page = loadAuctionPage();
    await page.flush();

    const select = $<HTMLSelectElement>(
      page.document,
      `#${FEATURE_ID} select[data-slot="value"]`,
    );
    changeSelect(page.window, select, "Обязательно");

    const textarea = $<HTMLTextAreaElement>(
      page.document,
      `[data-note="${NOTE_ID}"] textarea`,
    );
    typeInto(page.window, textarea, "мой ответ");

    const slot = select.closest(".slot");
    if (!(slot instanceof page.window.HTMLElement))
      throw new Error(".slot не найден");
    expect(slot.dataset["filled"]).toBe("yes");
    expect(slot.querySelector(".slot-print")?.textContent).toBe("Обязательно");

    const note = page.document.querySelector(`[data-note="${NOTE_ID}"]`);
    if (!(note instanceof page.window.HTMLElement))
      throw new Error("заметка не найдена");
    expect(note.dataset["answered"]).toBe("yes");
    expect(note.querySelector(".answer-print")?.textContent).toBe("мой ответ");
  });
});
