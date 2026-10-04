import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Пустой набор и забытый `.only` — отказ, а не зелёный прогон.
    passWithNoTests: false,
    allowOnly: false,
  },
});
