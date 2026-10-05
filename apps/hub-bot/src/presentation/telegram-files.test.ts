import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramFiles } from "./telegram-files.js";

// Настоящий адаптер скачивания над локальным HTTP-сервером вместо Telegram:
// адрес файла, отказ, обрыв по времени и по размеру (PER-452).

const token = "111:secret-token";
let server: Server | undefined;
const requested: string[] = [];

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  server = createServer((request, response) => {
    requested.push(request.url ?? "");
    handler?.(request, response);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  requested.length = 0;
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe("telegram file download", () => {
  it("reads the bytes from the file address of the bot in the test environment", async () => {
    const apiRoot = await serve((_request, response) => {
      response.end(Buffer.from([0xff, 0xd8, 0xff]));
    });
    const files = createTelegramFiles({ token, environment: "test", apiRoot });

    await expect(files.download("photos/file_1.jpg")).resolves.toEqual({
      kind: "ok",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(requested).toEqual([`/file/bot${token}/test/photos/file_1.jpg`]);
  });

  it("names a refusal of Telegram without the address that carries the token", async () => {
    const apiRoot = await serve((_request, response) => {
      response.statusCode = 404;
      response.end("Not Found");
    });
    const files = createTelegramFiles({ token, environment: "prod", apiRoot });

    const result = await files.download("photos/file_1.jpg");

    expect(result).toEqual({
      kind: "failed",
      reason: "unavailable",
      cause: new Error("file download answered HTTP 404"),
    });
    expect(requested).toEqual([`/file/bot${token}/photos/file_1.jpg`]);
  });

  it("gives up on a file that does not arrive in time", async () => {
    const apiRoot = await serve(() => {
      // Ответа нет: соединение висит, пока адаптер не оборвёт его сам.
    });
    const files = createTelegramFiles({
      token,
      environment: "prod",
      apiRoot,
      timeoutMs: 50,
    });

    const result = await files.download("photos/file_1.jpg");

    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(result.kind === "failed" && result.cause.message).not.toContain(
      token,
    );
  });

  it("stops reading a file above its limit", async () => {
    const apiRoot = await serve((_request, response) => {
      response.end(Buffer.alloc(64));
    });
    const files = createTelegramFiles({
      token,
      environment: "prod",
      apiRoot,
      maxBytes: 16,
    });

    await expect(files.download("photos/file_1.jpg")).resolves.toEqual({
      kind: "failed",
      reason: "unavailable",
      cause: new Error("file download exceeded 16 bytes"),
    });
  });
});
