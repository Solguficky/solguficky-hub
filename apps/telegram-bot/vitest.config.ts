import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Классификатор отказов и разбор секретов живого контура — L0: живой прогон
    // редок, и сломанный разбор иначе всплыл бы только у владельца.
    include: ["src/**/*.test.ts", "../../tests/telegram-live/**/*.test.ts"],
    // Наборы с контейнерами — уровень L1: их гоняет vitest.integration.config.ts
    // (`npm run test:integration`), а `npm test` и `just verify` остаются без Docker.
    // Живой контур — L3 и ходит в Telegram: его гоняет vitest.live.config.ts.
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.integration.test.ts",
      "../../tests/telegram-live/**/*.live.test.ts",
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
