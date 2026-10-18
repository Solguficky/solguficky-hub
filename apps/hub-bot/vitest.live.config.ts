import { defineConfig } from "vitest/config";

// Уровень L3 (ADR-046): `/start` и кадры ошибок через настоящий Telegram
// тестовой среды.
// Сценарии и драйвер лежат в `tests/telegram-live` со своей зависимостью
// mtcute — боту она не принадлежит, — а раннер один с остальными наборами бота.
// Запуск — `just telegram-live-test` против бота, которого поднял владелец; в
// verify, test-all и CI набор не входит ни при какой стабильности.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    dir: "../../tests/telegram-live",
    include: ["**/*.live.test.ts"],
    // Один аккаунт и один бот: параллельные сценарии читали бы чужие ответы.
    fileParallelism: false,
    // Пропуск не равен прохождению: пустой набор и забытый `.only` — отказ.
    passWithNoTests: false,
    allowOnly: false,
    // Соединение с DC и ответ бота укладываются в дедлайны драйвера (20 и 15 с).
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
