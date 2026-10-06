import { defineConfig } from "vitest/config";

// Пульт провода двух ботов на среде Contour.Host с Auction: человек или агент
// ведёт разговор с ботами по шагу через HTTP на 127.0.0.1. Не гейт и не набор —
// vitest здесь только загрузчик TypeScript. Рецепт `just contour-bot-console`
// не входит ни в `verify`, ни в `test-all`, ни в CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["*.console.ts"],
    passWithNoTests: false,
    allowOnly: false,
    hookTimeout: 90_000,
    // Пульт живёт, пока его не остановят командой `quit` или Ctrl+C.
    testTimeout: 0,
    // Строка готовности нужна сразу, а не после конца «теста».
    disableConsoleIntercept: true,
  },
});
