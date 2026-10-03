import { defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

// Уровень L1: наборы, которым нужен Docker (Testcontainers). В `just verify` не
// входят — их гоняют `just hub-bot-test-integration`, `just test-all` и CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    include: ["src/**/*.integration.test.ts"],
  },
});
