// Сборка PNG ачивок из SVG-шаблона (template.ts) в apps/achievements/priv/achievements:
// Telegram не принимает SVG как фото, поэтому поставка везёт PNG рядом с
// определением (ADR-077, п. 2). PNG лежат в Git, образ их не пересобирает.
//
//   node render.ts write — перерисовать все картинки;
//   node render.ts check — перерисовать в память и упасть, если байты
//     расходятся с файлами в Git или в каталоге есть лишний файл.
//
// Рендер детерминирован: resvg в wasm без системных шрифтов, шрифт — DejaVu Sans
// Bold из закреплённого пакета, версии — в package-lock.json.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import badges from "./badges.json" with { type: "json" };
import { type Badge, svg, width } from "./template.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "priv", "achievements");
const require = createRequire(import.meta.url);

async function render(list: Badge[]): Promise<Map<string, Uint8Array>> {
  await initWasm(
    readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")),
  );
  const font = readFileSync(
    require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"),
  );

  const images = new Map<string, Uint8Array>();
  for (const badge of list) {
    const resvg = new Resvg(svg(badge), {
      fitTo: { mode: "width", value: width },
      font: {
        fontBuffers: [new Uint8Array(font)],
        defaultFontFamily: "DejaVu Sans",
        loadSystemFonts: false,
      },
    });
    images.set(`${badge.code}.png`, resvg.render().asPng());
  }
  return images;
}

async function main(mode: string | undefined): Promise<number> {
  const images = await render(badges as Badge[]);

  if (mode === "write") {
    for (const [file, png] of images) writeFileSync(join(out, file), png);
    process.stdout.write(
      `achievement images: ${images.size} written to ${out}\n`,
    );
    return 0;
  }

  if (mode === "check") {
    const drift: string[] = [];
    for (const [file, png] of images) {
      let committed: Uint8Array | undefined;
      try {
        committed = readFileSync(join(out, file));
      } catch {
        committed = undefined;
      }
      if (committed === undefined) drift.push(`${file}: missing`);
      else if (!Buffer.from(committed).equals(Buffer.from(png)))
        drift.push(`${file}: differs from the template`);
    }
    for (const file of readdirSync(out)) {
      if (!images.has(file)) drift.push(`${file}: no badge renders it`);
    }
    if (drift.length > 0) {
      process.stderr.write(
        `achievement images drifted — run \`just achievements-images\`:\n  ${drift.join("\n  ")}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `achievement images: ${images.size} match the template\n`,
    );
    return 0;
  }

  process.stderr.write("usage: node render.ts write | check\n");
  return 2;
}

process.exitCode = await main(process.argv[2]);
