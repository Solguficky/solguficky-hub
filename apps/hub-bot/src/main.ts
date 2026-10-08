import { runProcess } from "./core/process.js";
import { readSurface } from "./core/surface.js";
import { auctionSurface } from "./surfaces/auction/surface.js";
import { hubSurface } from "./surfaces/hub/surface.js";

// Один пакет, два процесса (ADR-064, п. 18): поверхность выбирает переменная
// `BOT_SURFACE`, и процесс поднимает её дерево экранов, её команды и её durable
// доставки вокруг общего процесса `src/core/process.ts`. Умолчания нет:
// процесс без поверхности не угадывает, чьим ботом ему быть. Это единственный
// модуль, который знает обе поверхности.
const surface = readSurface(process.env["BOT_SURFACE"]);
if (surface.ok) {
  runProcess(
    surface.surface,
    surface.surface === "hub" ? hubSurface : auctionSurface,
  );
} else {
  process.stderr.write(
    `${JSON.stringify({ service: "bot", level: "error", msg: surface.error })}\n`,
  );
  process.exit(1);
}
