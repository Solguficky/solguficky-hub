import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Три слоя лежат рядом с тем, что проверяют: логика документа в `src/`,
    // HTTP-граница в `netlify/functions/`, страница в `page/`.
    include: ["src/**/*.test.ts", "netlify/**/*.test.mts", "page/**/*.test.ts"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
