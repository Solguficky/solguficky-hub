import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
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
