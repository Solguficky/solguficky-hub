// Слой 3: страница без рабочего сервера — ссылка на документ, которого нет,
// и полное отсутствие функции API (голая статика). В обоих случаях браузер
// обязан остаться рабочим блокнотом.
import { expect, test } from "@playwright/test";
import { firstAnswer, PAGE, status } from "./helpers.js";

test("ссылка на несуществующий документ не мешает работе в этом браузере", async ({
  page,
}) => {
  // Форма верная (22 символа из разрешённого алфавита), но такого документа
  // на сервере нет и не будет: идентификаторы выдаются случайными.
  const missingId = "N".repeat(22);

  await page.goto(PAGE);
  await (await firstAnswer(page)).fill("заметка из этого браузера");
  await expect(status(page)).toHaveText("Только в этом браузере");

  await page.goto(`${PAGE}?doc=${missingId}`);

  await expect(status(page)).toHaveText(
    "Документ по ссылке не найден, показаны заметки из браузера",
  );
  await expect(page.locator("#sync-enable")).toBeVisible();
  await expect(await firstAnswer(page)).toHaveValue(
    "заметка из этого браузера",
  );
});

test("страница работает как чистая статика, когда функции api вовсе нет", async ({
  page,
}) => {
  // Так отвечает хостинг без опубликованной функции: 404 с телом HTML.
  // Обработчик на такой отказ отвечает JSON — по форме тела страница и
  // отличает «функции нет» от «документ удалён».
  await page.route("**/api/notes**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/html; charset=utf-8",
      body: "<html><body>Not Found</body></html>",
    }),
  );

  await page.goto(PAGE);
  await (await firstAnswer(page)).fill("заметка без сервера");
  await expect(status(page)).toHaveText("Только в этом браузере");

  await page.locator("#sync-enable").click();
  await expect(status(page)).toHaveText(
    "Сервер недоступен: заметки остаются в браузере",
  );

  // Заполненное живёт в localStorage и переживает перезагрузку страницы.
  await page.reload();
  await expect(await firstAnswer(page)).toHaveValue("заметка без сервера");
});
