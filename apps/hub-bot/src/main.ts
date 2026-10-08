import { startHub } from "./hub-main.js";
import { readSurface } from "./surface.js";
import { startAuction } from "./surfaces/auction/main.js";

// Один пакет, два процесса (ADR-064, п. 18): поверхность выбирает переменная
// `BOT_SURFACE`, и каждый процесс поднимает своё дерево экранов, свои команды и
// свой durable доставки. Умолчания нет: процесс без поверхности не угадывает,
// чьим ботом ему быть.
const surface = readSurface(process.env["BOT_SURFACE"]);
if (surface.ok) {
  if (surface.surface === "hub") startHub();
  else startAuction();
} else {
  process.stderr.write(
    `${JSON.stringify({ service: "bot", level: "error", msg: surface.error })}\n`,
  );
  process.exit(1);
}
