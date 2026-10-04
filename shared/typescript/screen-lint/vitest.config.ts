import { defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    include: ["src/**/*.test.ts"],
    // Пустой набор и забытый `.only` — отказ, а не зелёный прогон.
    passWithNoTests: false,
    allowOnly: false,
  },
});
