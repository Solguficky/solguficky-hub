import { defineConfig } from "vitest/config";

// Уровень L1: наборы, которым нужен Docker (Testcontainers). В `just verify` не
// входят — их гоняют `just telegram-bot-test-integration`, `just test-all` и CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
