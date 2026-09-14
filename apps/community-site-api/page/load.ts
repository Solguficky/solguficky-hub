// Общий помощник слоя 2 и слоя 4: грузит настоящую опубликованную страницу в
// jsdom и, для «Аукциона 2026», ставит подмены, которых в jsdom нет —
// `fetch`, буфер обмена, `showModal`/`close` у `<dialog>` и `matchMedia`.
// Страница не написана с оглядкой на тесты, поэтому подмены обязаны встать
// раньше инлайнового `<script>`: `beforeParse` вызывается до разбора тела
// документа, а `runScripts: "dangerously"` исполняет скрипт сразу по ходу
// разбора.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DOMWindow, JSDOM, VirtualConsole } from "jsdom";

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));

/** Каталог настоящих опубликованных страниц: слой 4 обходит его целиком. */
export const PUBLISHED_DIR = resolve(HERE, "../../../docs/published");

/** Страница «Аукцион 2026»: на ней живёт клиентская логика синхронизации. */
export const AUCTION_PAGE_PATH = resolve(
  PUBLISHED_DIR,
  "auction-2026/index.html",
);

export interface FetchCall {
  readonly method: string;
  /** Хвост адреса после `/api/notes`: `""`, `"/docId"`, `"/docId/versions"`… */
  readonly path: string;
  readonly body: unknown;
}

export interface FetchResult {
  readonly status?: number;
  readonly body?: unknown;
  /** `response.json()` бросает — так на отказ без функции отвечает статика. */
  readonly notJson?: boolean;
}

export type FetchHandler = (
  call: FetchCall,
) => FetchResult | Promise<FetchResult>;

const API_PREFIX = "/api/notes";

export interface LoadedPage {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  /** Все запросы к API по порядку отправки: многие кейсы проверяют очерёдность,
   *  а не только финальный ответ. */
  readonly calls: FetchCall[];
  setFetchHandler(handler: FetchHandler | null): void;
  /** Прогоняет несколько витков микрозадач. Цепочка внутри страницы — это
   *  несколько последовательных `await` (`fetch` → `json` → применение), а
   *  фальшивые таймеры vitest их не продвигают: микрозадачи не таймер. */
  flush(): Promise<void>;
}

export interface LoadOptions {
  readonly url?: string;
  readonly seedLocalStorage?: Readonly<Record<string, string>>;
  readonly fetchHandler?: FetchHandler;
}

const parseRequestInit = (
  init: RequestInit | undefined,
): { method: string; body: unknown } => {
  const method = init?.method ?? "GET";
  const rawBody = init?.body;
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    return { method, body: undefined };
  }
  try {
    return { method, body: JSON.parse(rawBody) };
  } catch {
    return { method, body: rawBody };
  }
};

const installStubs = (
  window: Window & typeof globalThis,
  calls: FetchCall[],
  dispatch: (call: FetchCall) => FetchResult | Promise<FetchResult>,
): void => {
  // Тема по умолчанию читает matchMedia; jsdom его не реализует вовсе.
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;

  // jsdom знает про <dialog>, но showModal/close не реализованы: странице
  // достаточно того, что они выставляют и снимают атрибут open.
  window.HTMLDialogElement.prototype.showModal = function (
    this: HTMLDialogElement,
  ): void {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function (
    this: HTMLDialogElement,
  ): void {
    this.removeAttribute("open");
  };

  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  });

  window.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const { method, body } = parseRequestInit(init);
    const path = url.startsWith(API_PREFIX)
      ? url.slice(API_PREFIX.length)
      : url;
    const call: FetchCall = { method, path, body };
    calls.push(call);
    const result = await dispatch(call);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (result.notJson) throw new SyntaxError("Тело ответа — не JSON");
        return result.body;
      },
    } as unknown as Response;
  }) as typeof window.fetch;
};

/** Грузит `docs/published/auction-2026/index.html` в jsdom и исполняет её
 *  скрипт целиком: и блок вкладок/печати, и блок синхронизации заметок. */
export const loadAuctionPage = (options: LoadOptions = {}): LoadedPage => {
  const html = readFileSync(AUCTION_PAGE_PATH, "utf8");
  const calls: FetchCall[] = [];
  let handler: FetchHandler | null = options.fetchHandler ?? null;

  const dom = new JSDOM(html, {
    url: options.url ?? "http://localhost/auction-2026",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    // jsdom объявляет окно как `DOMWindow`; тестам удобнее полный тип
    // браузерного окна, и приведение делается здесь один раз.
    beforeParse(parsing: DOMWindow) {
      const window = parsing as unknown as Window & typeof globalThis;
      if (options.seedLocalStorage) {
        for (const [key, value] of Object.entries(options.seedLocalStorage)) {
          window.localStorage.setItem(key, value);
        }
      }
      installStubs(window, calls, (call) => {
        if (!handler) {
          throw new Error(
            `page/load.ts: нет обработчика fetch для ${call.method} ${call.path}`,
          );
        }
        return handler(call);
      });
    },
  });

  const window = dom.window as unknown as Window & typeof globalThis;
  return {
    window,
    document: window.document,
    calls,
    setFetchHandler(next) {
      handler = next;
    },
    flush: () => flushMicrotasks(),
  };
};

export const flushMicrotasks = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
};

/** Управляемый промис: тест решает сам, когда «сервер» ответит — нужно, чтобы
 *  проверить поведение во время ещё не завершившегося запроса. */
export const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

export interface NotesStateLike {
  readonly slots?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly answers?: Readonly<Record<string, string>>;
  readonly priorities?: readonly string[];
}

export interface NotesStateFull {
  readonly slots: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly answers: Readonly<Record<string, string>>;
  readonly priorities: readonly string[];
}

/** Состояние документа для тела запросов и ответов. Незаданные поля приходят
 *  пустыми — этого достаточно везде, где кейс проверяет не форму состояния, а
 *  факт запроса или его очерёдность. */
export const makeState = (overrides: NotesStateLike = {}): NotesStateFull => ({
  slots: overrides.slots ?? {},
  answers: overrides.answers ?? {},
  priorities: overrides.priorities ?? [],
});

export interface NotesVersionLike {
  readonly number: number;
  readonly at: string;
  readonly label: string;
  readonly state: NotesStateLike;
  readonly restoredFrom?: number;
}

export interface NotesDocumentLike {
  readonly docId: string;
  readonly revision: number;
  readonly state: NotesStateFull;
  readonly versions: readonly NotesVersionLike[];
}

/** Документ в форме, которую отдаёт `/api/notes/:docId`: страница читает из
 *  него только `docId`, `revision`, `state` и `versions`. */
export const makeDocument = (
  overrides: {
    readonly docId?: string;
    readonly revision?: number;
    readonly state?: NotesStateLike;
    readonly versions?: readonly NotesVersionLike[];
  } = {},
): NotesDocumentLike => {
  const state = makeState(overrides.state);
  return {
    docId: overrides.docId ?? "AbCdEfGhIjKlMnOpQrStUv",
    revision: overrides.revision ?? 1,
    state,
    versions: overrides.versions ?? [
      {
        number: 1,
        at: "2026-01-01T00:00:00.000Z",
        label: "Начальная версия",
        state,
      },
    ],
  };
};

// ------------------------------------------------------------ слой 4: разметка

export interface StaticPage {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
}

/** Обходит `docs/published` целиком и возвращает путь к каждой странице —
 *  список составляется по каталогу, а не перечисляется руками, поэтому новая
 *  опубликованная страница подхватывается сама. */
export const findPublishedPages = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "index.html") found.push(full);
    }
  };
  walk(PUBLISHED_DIR);
  return found.sort();
};

/** Адрес, под которым страница реально отдаётся сайтом: `docs/published/x/index.html`
 *  живёт по `/x` — см. ссылки в `docs/published/index.html`. */
const toServedUrl = (filePath: string): string => {
  const relative = filePath
    .slice(PUBLISHED_DIR.length)
    .replace(/\\/g, "/")
    .replace(/\/index\.html$/, "");
  return `http://localhost${relative === "" ? "/" : relative}`;
};

/** Грузит произвольную опубликованную страницу для слоя 4. Скрипты исполняются
 *  (`runScripts: "dangerously"`) — на «Аукционе 2026» разметку из `.answer` и
 *  `.grip` создаёт клиентский код, и без исполнения её просто не будет в DOM.
 *  Тихая `VirtualConsole` глотает то, что чужой странице не даёт эмулировать
 *  jsdom (`ResizeObserver`, `<canvas>` — у архивной презентации), это шум
 *  окружения, а не находка о разметке. `matchMedia` подменяется заранее: без
 *  него скрипт «Аукциона 2026» падает на первой же строчке про тему, и весь
 *  остальной блок синхронизации вместе с ним. */
export const loadPublishedPage = (filePath: string): StaticPage => {
  const html = readFileSync(filePath, "utf8");
  const dom = new JSDOM(html, {
    url: toServedUrl(filePath),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(parsing: DOMWindow) {
      const window = parsing as unknown as Window & typeof globalThis;
      window.matchMedia = ((query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
      window.HTMLDialogElement.prototype.showModal = function (
        this: HTMLDialogElement,
      ): void {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function (
        this: HTMLDialogElement,
      ): void {
        this.removeAttribute("open");
      };
    },
  });
  const window = dom.window as unknown as Window & typeof globalThis;
  return { window, document: window.document };
};

export interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: ReadonlyArray<{ readonly target: readonly string[] }>;
}

export interface AxeResults {
  readonly violations: readonly AxeViolation[];
}

export interface AxeRunner {
  run(
    context: Document,
    options?: Record<string, unknown>,
  ): Promise<AxeResults>;
}

/** Впрыскивает `axe-core` прямо в реальность загруженной страницы через
 *  `window.eval`: axe сверяет объекты через `instanceof` своего же `window`,
 *  и прогон из чужой реальности Node молча не находит там ничего. */
export const loadAxe = (page: StaticPage): AxeRunner => {
  const axeSource = readFileSync(
    require.resolve("axe-core/axe.min.js"),
    "utf8",
  );
  page.window.eval(axeSource);
  return (page.window as unknown as { axe: AxeRunner }).axe;
};
