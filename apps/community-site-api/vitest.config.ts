import { defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    // Три слоя лежат рядом с тем, что проверяют: логика документа в `src/`,
    // HTTP-граница в `boundary/`, страница в `page/`. Тесты границы лежат не
    // в самом `netlify/functions/`: каждый файл того каталога Netlify
    // регистрирует функцией, а имя `notes.test` он отвергает.
    include: [
      "src/**/*.test.ts",
      "boundary/**/*.test.mts",
      "page/**/*.test.ts",
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
