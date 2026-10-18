import { configDefaults, defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

// L0 наполнения: разбор каталога, переменных и порядок вызовов на фейках
// портов. Ни сервисов, ни Docker им не нужно; само наполнение (`*.seed.ts`)
// гоняет `vitest.seed.config.ts`.
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
