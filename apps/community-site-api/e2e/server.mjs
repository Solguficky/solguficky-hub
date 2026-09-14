// Проверочный сервер для E2E и для ручного прогона страницы.
//
// Отдаёт `docs/published` так же, как это делает хостинг (каталог — адрес,
// страница всегда `index.html`), и поднимает рядом настоящий обработчик
// `netlify/functions/notes.mts`. Обработчик берётся настоящий намеренно: его
// пересказ означал бы, что E2E проверяет пересказ.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import * as hooks from "./hooks.mjs";

// Хуки ставятся до первого импорта обработчика: подменять разрешение
// модулей после него было бы поздно.
registerHooks(hooks);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SITE_ROOT = resolvePath(HERE, "../../../docs/published");

const { default: notes } = await import("../netlify/functions/notes.mts");

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

/** Контекст деплоя. Не продакшен: проверочные документы не должны выглядеть
 *  как рабочие даже в подменённом хранилище. */
const context = { deploy: { context: "dev" } };

const toRequest = async (incoming, url) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(url, {
    method: incoming.method,
    headers: incoming.headers,
    ...(body === undefined ? {} : { body }),
  });
};

const sendFile = async (response, filePath) => {
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type":
        TYPES.get(extname(filePath)) ?? "application/octet-stream",
      // Страница правится и перезагружается прямо во время прогона.
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Не найдено");
  }
};

const server = createServer(async (incoming, response) => {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);

  if (url.pathname === "/api/notes" || url.pathname.startsWith("/api/notes/")) {
    const result = await notes(await toRequest(incoming, url.href), context);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
    return;
  }

  // Обход каталога наружу запрещён: путь нормализуется и проверяется, что он
  // остался внутри корня сайта.
  const relative = normalize(decodeURIComponent(url.pathname)).replace(
    /^([/\\])+/,
    "",
  );
  const target = resolvePath(SITE_ROOT, relative);
  if (!target.startsWith(SITE_ROOT)) {
    response.writeHead(403);
    response.end();
    return;
  }
  await sendFile(
    response,
    extname(target) ? target : join(target, "index.html"),
  );
});

const port = Number(process.env["PORT"] ?? 4321);
server.listen(port, () => {
  process.stdout.write(`Сайт сообщества: http://localhost:${port}/\n`);
});
