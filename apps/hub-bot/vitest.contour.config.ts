import { configDefaults, defineConfig } from "vitest/config";
import { FailOnSkip } from "./vitest.fail-on-skip.js";

// Уровень L2: провод бота против настоящих Identity и Meetups. Сценарии лежат
// в `tests/contour/bot-wire` — набор пересекает несколько деплоимых единиц и
// компоненту не принадлежит, — а зависимости и kit берёт у бота. Среду не
// поднимает: её отдаёт `just contour-bot-test` через Contour.Host.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    // Пропуск роняет прогон (vitest.fail-on-skip.ts); `default` перечислен
    // явно, иначе своё поле reporters снимает штатный вывод.
    reporters: ["default", new FailOnSkip()],
    // Тот же линтер экрана, что на L0: сценарий против настоящих сервисов
    // отправляет те же экраны.
    setupFiles: ["./testkit/lint-setup.ts"],
    dir: "../../tests/contour/bot-wire",
    include: ["**/*.test.ts"],
    // Исследующий прогон — не гейт (vitest.explore.config.ts). Суффикс
    // `.explore.ts` его уже не подхватывает; исключение держит границу и при
    // переименовании файла.
    // Пульт (`console/`) — тоже не набор: его разбор команд гоняет L0
    // `vitest.config.ts`, а сам пульт — `vitest.console.config.ts`.
    exclude: [...configDefaults.exclude, "explore/**", "console/**"],
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
