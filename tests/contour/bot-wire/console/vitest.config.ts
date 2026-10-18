import { configDefaults, defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

// L0 пульта: разбор языка команд и прокси задержки с обрывом. Ни контура, ни
// Docker им не нужно; сам пульт (`*.console.ts`) гоняет `vitest.console.config.ts`.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    include: ["*.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: false,
    allowOnly: false,
  },
});
