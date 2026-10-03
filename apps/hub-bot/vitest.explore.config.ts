import { defineConfig } from "vitest/config";

// Исследующий прогон RFC-012 (роль 3) на той же среде, что провод бота:
// случайные последовательности действий, оракулы — каркас записи логов. Не
// гейт: `vitest.contour.config.ts` каталог `explore/` исключает явно, а рецепт
// `just contour-bot-explore` не входит ни в `verify`, ни в `test-all`, ни в CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    dir: "../../tests/contour/bot-wire/explore",
    include: ["**/*.explore.ts"],
    fileParallelism: false,
    passWithNoTests: false,
    allowOnly: false,
    hookTimeout: 90_000,
    // Сотни шагов против настоящих сервисов: предел — от зависания, а не от
    // медленного прогона.
    testTimeout: 30 * 60_000,
  },
});
