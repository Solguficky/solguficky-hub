// Хуки резолвера для проверочного сервера. Синхронные: их ставит
// `module.registerHooks`, исполняющий хуки в том же потоке.
//
// Подмен две, и обе нужны, чтобы E2E гонял настоящий обработчик
// `netlify/functions/notes.mts`, а не его пересказ.
//
// 1. `@netlify/blobs` уводится на `blobs-stub.mjs`: настоящему хранилищу нужны
//    учётная запись и сеть.
// 2. Импорт вида `./document.js` доводится до `./document.ts`. Так пишет
//    TypeScript в режиме NodeNext — расширение скомпилированного файла, — а
//    Node типы только срезает и такой файл не находит.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLOBS_STUB = new URL("./blobs-stub.mjs", import.meta.url).href;

const SOURCE_EXTENSION = new Map([
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
]);

export const resolve = (specifier, context, nextResolve) => {
  if (specifier === "@netlify/blobs") {
    return { url: BLOBS_STUB, shortCircuit: true, format: "module" };
  }

  if (specifier.startsWith(".") && context.parentURL) {
    const target = new URL(specifier, context.parentURL);
    const extension = SOURCE_EXTENSION.get(
      target.pathname.slice(target.pathname.lastIndexOf(".")),
    );
    if (extension && !existsSync(fileURLToPath(target))) {
      const source = new URL(target.href.replace(/\.[cm]?js$/, extension));
      if (existsSync(fileURLToPath(source))) {
        return {
          url: pathToFileURL(fileURLToPath(source)).href,
          shortCircuit: true,
          format: "module-typescript",
        };
      }
    }
  }

  return nextResolve(specifier, context);
};
