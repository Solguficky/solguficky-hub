import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  botInfo as auctionBotInfo,
  openAuctionBotWire,
  readAuctionContourEnvironment,
} from "../../../../apps/auction-bot/testkit/index.js";
import {
  openBotWire,
  openDirectClients,
  readContourEnvironment,
} from "../../../../apps/hub-bot/testkit/index.js";
import { CommandError, help, parseCommand } from "./commands.js";
import { openLatency } from "./latency.js";
import { openConsoleSession, type Reply } from "./session.js";

// Пульт провода двух ботов: человек или агент ведёт разговор по шагу — пишет,
// жмёт кнопки по подписи и читает экраны — с ботом хаба и ботом аукциона
// против настоящих Identity, Meetups и Auction. Уровень L2, Telegram не
// участвует. Не гейт и не набор: файл назван `*.console.ts`, его гоняет только
// `vitest.console.config.ts` (`just contour-bot-console`), а vitest здесь —
// загрузчик TypeScript. Среду поднимает Contour.Host с `--with-auction`.
//
// Команда — строка в теле POST, ответ — JSON:
//   curl -sS --data-binary 'alice@hub say /start' http://127.0.0.1:7357/
// Язык команд — `commands.ts`. Каждый обмен дописывается в
// `.work/bot-console/<время старта>.jsonl`, чтобы владелец видел, что делал агент.
//
//   BOT_CONSOLE_PORT=<n>   порт на 127.0.0.1 (7357)

const port = readPort(process.env["BOT_CONSOLE_PORT"]) ?? 7357;
const maxBodyBytes = 16 * 1024;

// Имя бота аукциона для ссылки из хаба человеку с `public` (PER-455) — ник
// заглушки `botInfo` kit бота аукциона: пульт url-кнопку не нажимает, а ссылка
// на экране должна вести на того бота, с которым человек здесь говорит.
const auctionBotUsername = auctionBotInfo.username;

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const transcriptDir = resolve(repoRoot, ".work/bot-console/");
const transcript = resolve(
  transcriptDir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);

const environment = readContourEnvironment();
const auctionEnvironment = readAuctionContourEnvironment();
const direct = openDirectClients(environment);

beforeAll(async () => {
  await direct.waitUntilReachable();
});

afterAll(() => {
  direct.close();
});

describe("bot wire console", () => {
  it("serves commands until quit", async () => {
    mkdirSync(transcriptDir, { recursive: true });
    // Боты ходят к сервисам через прокси задержки и обрыва (`slow`, `down`),
    // прямые клиенты — мимо него: заведение людей и проверка итога не ждут
    // вместе с ботом.
    const latency = await openLatency({
      identity: environment.identityUrl,
      meetups: environment.meetupsUrl,
      auction: auctionEnvironment.auctionUrl,
    });
    const hub = openBotWire({
      ...environment,
      identityUrl: latency.urls.identity,
      meetupsUrl: latency.urls.meetups,
      auctionUrl: latency.urls.auction,
      auctionBotUsername,
    });
    const auction = openAuctionBotWire({
      ...auctionEnvironment,
      identityUrl: latency.urls.identity,
      auctionUrl: latency.urls.auction,
    });
    const session = openConsoleSession({ hub, auction }, direct, latency);

    try {
      await new Promise<void>((resolveServed, rejectServed) => {
        const server = createServer((request, response) => {
          const answer = (status: number, reply: Reply): void => {
            response.writeHead(status, {
              "content-type": "application/json; charset=utf-8",
            });
            response.end(`${JSON.stringify(reply, bigintAsString, 2)}\n`);
          };

          if (request.method === "GET") {
            // Готовность и справка разом: пульт слушает только после ответа
            // сервисов.
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
                // Ошибка команды — 400: её исправляет человек за пультом.
                // Остальное — отказ провода или сервиса, 500, и сообщение как есть.
                status = error instanceof CommandError ? 400 : 500;
                reply = {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
              appendFileSync(
                transcript,
                `${JSON.stringify({ at: new Date().toISOString(), command: line, status, reply }, bigintAsString)}\n`,
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
            `bot-console: ready on http://127.0.0.1:${port}/ ; ` +
              `transcript ${relative(repoRoot, transcript)}`,
          );
        });
      });
    } finally {
      hub.close();
      auction.close();
      await latency.close();
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

function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function readPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`BOT_CONSOLE_PORT=${raw}: нужен порт от 1 до 65535`);
  }
  return value;
}
