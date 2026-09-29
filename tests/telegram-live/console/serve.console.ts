import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "../../../apps/telegram-bot/testkit/index.js";
import { type LiveClient, openLiveClient } from "../driver.js";
import { classifyFailure } from "../failure.js";
import { pickLiveSecrets, readSecretStore } from "../session.js";
import { CommandError, help, parseCommand } from "./commands.js";
import { openLiveConsoleSession, type Reply } from "./session.js";

// Живой пульт (L3, ADR-046): синтетический аккаунт тестовой среды Telegram
// ведёт разговор с ботом по шагу — пишет, жмёт inline-кнопки по подписи и
// читает экраны — через настоящий Telegram. Бота поднимает владелец —
// `aspire run -- --profile hub --telegram-environment test`; пульт его не
// запускает. Не гейт и не набор: файл назван `*.console.ts`, его гоняет только
// `vitest.live-console.config.ts` (`just telegram-live-console`).
//
// Команда — строка в теле POST, ответ — JSON:
//   curl -sS --data-binary 'say /start' http://127.0.0.1:7358/
// Язык команд — `commands.ts`. Каждый обмен дописывается в
// `.work/bot-console-live/<время старта>.jsonl`.
//
//   LIVE_CONSOLE_PORT=<n>   порт на 127.0.0.1 (7358)

const port = readPort(process.env["LIVE_CONSOLE_PORT"]) ?? 7358;
const maxBodyBytes = 16 * 1024;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const transcriptDir = resolve(repoRoot, ".work/bot-console-live/");
const transcript = resolve(
  transcriptDir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);

let live: LiveClient | undefined;

beforeAll(async () => {
  try {
    live = await openLiveClient(pickLiveSecrets(readSecretStore()));
  } catch (error) {
    throw classifyFailure(error);
  }
});

afterAll(async () => {
  await live?.client.destroy();
});

describe("live bot console", () => {
  it("serves commands until quit", async () => {
    if (live === undefined) {
      throw new Error("клиент не открыт: причина — в отказе beforeAll");
    }
    mkdirSync(transcriptDir, { recursive: true });
    const session = await openLiveConsoleSession(live);

    try {
      await new Promise<void>((resolveServed, rejectServed) => {
        const server = createServer((request, response) => {
          const answer = (status: number, reply: Reply): void => {
            response.writeHead(status, {
              "content-type": "application/json; charset=utf-8",
            });
            response.end(`${JSON.stringify(reply, null, 2)}\n`);
          };

          if (request.method === "GET") {
            answer(200, { ok: true, kind: "help", commands: help });
            return;
          }
          if (request.method !== "POST") {
            answer(405, { ok: false, error: "команда — строка в теле POST" });
            return;
          }
          readBody(request)
            .then(async (line) => {
              let reply: Reply;
              let status = 200;
              try {
                reply = await session.execute(parseCommand(line));
              } catch (error) {
                // Ошибка команды — 400; отказ Telegram — 500 с названной
                // причиной первым словом, как у живого прогона.
                status = error instanceof CommandError ? 400 : 500;
                reply = {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
              appendFileSync(
                transcript,
                `${JSON.stringify({ at: new Date().toISOString(), command: line, status, reply })}\n`,
              );
              answer(status, reply);
              if (reply.ok && reply.kind === "quit") {
                server.close(() => resolveServed());
                server.closeAllConnections();
              }
            })
            .catch((error: unknown) => {
              answer(400, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        });
        server.once("error", rejectServed);
        server.listen(port, "127.0.0.1", () => {
          console.log(
            `live-console: ready on http://127.0.0.1:${port}/ ; ` +
              `transcript ${relative(repoRoot, transcript)}`,
          );
        });
      });
    } finally {
      session.close();
    }
  });
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        rejectBody(new Error(`команда длиннее ${maxBodyBytes} байт`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolveBody(Buffer.concat(chunks).toString("utf8")),
    );
    request.on("error", rejectBody);
  });
}

function readPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`LIVE_CONSOLE_PORT=${raw}: нужен порт от 1 до 65535`);
  }
  return value;
}
