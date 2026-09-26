import { defineConfig } from "vitest/config";

// Уровень L2: провод бота против настоящих Identity и Meetups. Сценарии лежат
// в `tests/contour/bot-wire` — набор пересекает несколько деплоимых единиц и
// компоненту не принадлежит, — а зависимости и kit берёт у бота. Среду не
// поднимает: её отдаёт `just contour-bot-test` через Contour.Host.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    dir: "../../tests/contour/bot-wire",
    include: ["**/*.test.ts"],
    // Файлы делят одну топологию и одну базу: параллельный прогон смешал бы
    // их записи и сделал бы красный невоспроизводимым.
    fileParallelism: false,
    // Пропуск не равен прохождению: пустой набор и забытый `.only` — отказ.
    passWithNoTests: false,
    allowOnly: false,
    // Ожидание готовности укладывается в хук, а вызов с дедлайном 3 с — в тест.
    hookTimeout: 90_000,
    testTimeout: 30_000,
  },
});
