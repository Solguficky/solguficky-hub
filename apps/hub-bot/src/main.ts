import type { SurfaceDefinition } from "./core/process.js";
import { runProcess } from "./core/process.js";
import { readSurface, type Surface } from "./core/surface.js";
import { auctionSurface } from "./surfaces/auction/surface.js";
import { hubSurface } from "./surfaces/hub/surface.js";
import { supportSurface } from "./surfaces/support/surface.js";

// Один пакет, три процесса (ADR-064, п. 18; ADR-068, п. 1): поверхность
// выбирает переменная `BOT_SURFACE`, и процесс поднимает её бота, её команды и
// её вход из шины вокруг общего процесса `src/core/process.ts`. Умолчания нет:
// процесс без поверхности не угадывает, чьим ботом ему быть. Это единственный
// модуль, который знает все поверхности.
const definitions: Record<Surface, SurfaceDefinition> = {
  hub: hubSurface,
  auction: auctionSurface,
  support: supportSurface,
};

const surface = readSurface(process.env["BOT_SURFACE"]);
if (surface.ok) {
  runProcess(surface.surface, definitions[surface.surface]);
} else {
  process.stderr.write(
    `${JSON.stringify({ service: "bot", level: "error", msg: surface.error })}\n`,
  );
  process.exit(1);
}
