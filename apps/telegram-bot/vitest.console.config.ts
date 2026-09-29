import { defineConfig } from "vitest/config";

// Пульт провода бота на той же среде, что сценарии L2: человек или агент ведёт
// разговор с ботом по шагу через HTTP на 127.0.0.1. Не гейт и не набор — vitest
// здесь только загрузчик TypeScript с путями test kit. Рецепт
// `just contour-bot-console` не входит ни в `verify`, ни в `test-all`, ни в CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    dir: "../../tests/contour/bot-wire/console",
    include: ["**/*.console.ts"],
    passWithNoTests: false,
    allowOnly: false,
    hookTimeout: 90_000,
    // Пульт живёт, пока его не остановят командой `quit` или Ctrl+C.
    testTimeout: 0,
    // Строка готовности нужна сразу, а не после конца «теста».
    disableConsoleIntercept: true,
  },
});
