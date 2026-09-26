import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Наборы с контейнерами — уровень L1: их гоняет vitest.integration.config.ts
    // (`npm run test:integration`), а `npm test` и `just verify` остаются без Docker.
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
