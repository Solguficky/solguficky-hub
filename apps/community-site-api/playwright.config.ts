import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_PORT"] ?? 4321);
const BASE_URL = `http://localhost:${PORT}`;

// Слой 3: страница в настоящем браузере поверх настоящего обработчика
// (`e2e/server.mjs` подменяет только хранилище). Отдельно от `npm test`: этому
// слою нужен скачанный браузер, а `just verify` обязан работать без него.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Каждый сценарий заводит свой документ со случайным идентификатором,
  // поэтому параллельные прогоны друг другу не мешают. На раннере число
  // работников ограничено: там ядер меньше, чем на машине разработчика.
  // Поле объявляется условно: `exactOptionalPropertyTypes` не принимает
  // явный `undefined` там, где свойство просто опускается.
  ...(process.env["CI"] ? { workers: 2 } : {}),
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    locale: "ru-RU",
    // Разбор падения без следа означает повтор вручную; след дешевле.
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env["CI"],
    stdout: "ignore",
    stderr: "pipe",
  },
});
