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
    // Классификатор отказов и разбор секретов живого контура — L0: живой прогон
    // редок, и сломанный разбор иначе всплыл бы только у владельца.
    // Разбор языка пульта провода бота — тоже L0: пульт живёт на контуре, а его
    // синтаксис от контура не зависит. Модель экранов test kit — туда же: по
    // ней читают экран и пульт, и сценарии L2.
    include: [
      "src/**/*.test.ts",
      "testkit/**/*.test.ts",
      "../../tests/telegram-live/**/*.test.ts",
      "../../tests/contour/bot-wire/console/**/*.test.ts",
    ],
    // Наборы с контейнерами — уровень L1: их гоняет vitest.integration.config.ts
    // (`npm run test:integration`), а `npm test` и `just verify` остаются без Docker.
    // Живой контур — L3 и ходит в Telegram: его гоняет vitest.live.config.ts.
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.integration.test.ts",
      "../../tests/telegram-live/**/*.live.test.ts",
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
