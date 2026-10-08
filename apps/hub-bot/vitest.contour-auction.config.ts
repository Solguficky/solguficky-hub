import { defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

// Уровень L2 с Auction: провод обоих ботов против настоящих Identity, Meetups
// и Auction. Аукцион — расширение хаба и в основной контур не входит, поэтому
// сценарии лежат своим каталогом `tests/contour/bot-wire/auction/`, который
// `vitest.contour.config.ts` исключает, а гоняет их рецепт
// `just contour-bot-auction-test` — Contour.Host с `--with-auction`. В
// `verify`, `test-all` и CI рецепт не входит.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    reporters: ["default", new FailOnSkip()],
    setupFiles: ["./testkit/lint-setup.ts"],
    dir: "../../tests/contour/bot-wire/auction",
    include: ["**/*.test.ts"],
    // Файлы делят одну топологию и одну базу, как в основном контуре.
    fileParallelism: false,
    passWithNoTests: false,
    allowOnly: false,
    hookTimeout: 90_000,
    // Сценарий торгов проходит сходку, аукцион, лот, допуск и ставки
    // десятками шагов против настоящих сервисов.
    testTimeout: 120_000,
  },
});
