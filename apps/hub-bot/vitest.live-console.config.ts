import { defineConfig } from "vitest/config";

// Живой пульт (L3, ADR-046): синтетический аккаунт тестовой среды ведёт
// разговор с ботом по шагу через HTTP на 127.0.0.1. Не гейт и не набор —
// vitest здесь только загрузчик TypeScript. `vitest.live.config.ts` берёт
// `*.live.test.ts` и пульт не подхватывает. Рецепт `just telegram-live-console`
// не входит ни в `verify`, ни в `test-all`, ни в CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    dir: "../../tests/telegram-live/console",
    include: ["**/*.console.ts"],
    passWithNoTests: false,
    allowOnly: false,
    // Соединение с DC укладывается в дедлайн драйвера (20 с).
    hookTimeout: 60_000,
    // Пульт живёт, пока его не остановят командой `quit` или Ctrl+C.
    testTimeout: 0,
    // Строка готовности нужна сразу, а не после конца «теста».
    disableConsoleIntercept: true,
  },
});
