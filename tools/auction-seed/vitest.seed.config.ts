import { defineConfig } from "vitest/config";

// Наполнение аукциона stage по каталогу (`just auction-seed <каталог>`). Не
// гейт и не набор — vitest здесь только загрузчик TypeScript, как у пульта
// провода. Рецепт не входит ни в `verify`, ни в `test-all`, ни в CI.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["*.seed.ts"],
    passWithNoTests: false,
    allowOnly: false,
    // Каталог из десятков лотов с фото через туннель идёт минуты.
    testTimeout: 0,
    // Строки хода нужны сразу, а не после конца «теста».
    disableConsoleIntercept: true,
  },
});
