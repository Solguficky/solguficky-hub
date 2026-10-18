// Скачивание файла, который человек прислал боту (PER-452): фото лота уходит в
// Auction байтами (ADR-057, дополнение 2026-09-30). Путь файла даёт `getFile`
// Bot API, а сами байты отдаёт отдельный адрес вне методов Bot API, поэтому
// скачивание — порт: тест подменяет его, а настоящий адаптер ходит в Telegram.

/** Telegram отдаёт ботам файлы не больше 20 МБ; больше бот и не читает. */
export const maxDownloadBytes = 20 * 1024 * 1024;

const downloadTimeoutMs = 10_000;

/**
 * Итог скачивания. Причина отказа — без адреса: в адресе файла лежит токен
 * бота, и в запись границы он попасть не должен.
 */
export type FileDownload =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "failed"; reason: "timeout" | "unavailable"; cause: Error };

export type TelegramFiles = {
  /** `filePath` — поле `file_path` ответа `getFile`. */
  download(filePath: string): Promise<FileDownload>;
};

export function createTelegramFiles(options: {
  token: string;
  environment: "prod" | "test";
  fetch?: typeof fetch;
  apiRoot?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): TelegramFiles {
  const fetchFile = options.fetch ?? fetch;
  const root = options.apiRoot ?? "https://api.telegram.org";
  // Тестовая среда Telegram отдаёт файлы под тем же префиксом `test/`, что и
  // методы Bot API.
  const prefix = options.environment === "test" ? "test/" : "";
  return {
    async download(filePath) {
      const url = `${root}/file/bot${options.token}/${prefix}${filePath}`;
      try {
        const response = await fetchFile(url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? downloadTimeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return failed(`file download answered HTTP ${response.status}`);
        }
        return await readLimited(
          response,
          options.maxBytes ?? maxDownloadBytes,
        );
      } catch (cause) {
        // Сообщение `fetch` может нести адрес; остаётся только имя ошибки.
        const name = cause instanceof Error ? cause.name : "unknown";
        return failed(
          `file download failed: ${name}`,
          name === "TimeoutError" ? "timeout" : "unavailable",
        );
      }
    },
  };
}

function failed(
  message: string,
  reason: "timeout" | "unavailable" = "unavailable",
): FileDownload {
  return { kind: "failed", reason, cause: new Error(message) };
}

// Тело читается с подсчётом: заголовок длины может врать или отсутствовать, а
// процесс бота не должен держать в памяти больше, чем Telegram вообще отдаёт.
async function readLimited(
  response: Response,
  limit: number,
): Promise<FileDownload> {
  const reader = response.body?.getReader();
  if (reader === undefined) return failed("file download without a body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return failed(`file download exceeded ${limit} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}
