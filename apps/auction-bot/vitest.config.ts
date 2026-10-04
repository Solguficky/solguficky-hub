import { configDefaults, defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    // Линтер экрана: нарушение дизайн-кода роняет тест, который его отправил.
    setupFiles: ["./testkit/lint-setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
