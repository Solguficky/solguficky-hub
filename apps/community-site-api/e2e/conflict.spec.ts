// Слой 3: две развилки, которые видит читатель, когда два браузера
// расходятся во мнении о состоянии документа — «моё против серверного» и
// «мою правку перебили». Обе завязаны на настоящий 409 из обработчика.
import { expect, test } from "@playwright/test";
import {
  enableSync,
  firstAnswer,
  openHistory,
  PAGE,
  status,
} from "./helpers.js";

test("развилка «моё против серверного» переносит заметки браузера на сервер версией", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(PAGE);
  await (await firstAnswer(firstPage)).fill("ответ первого браузера");
  const link = await enableSync(firstPage);

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  // Заполняется ДО перехода по ссылке: правка ложится в localStorage второго
  // браузера, своего документа он ещё не знает.
  await secondPage.goto(PAGE);
  await (await firstAnswer(secondPage)).fill("ответ второго браузера");
  await expect(status(secondPage)).toHaveText("Только в этом браузере");

  await secondPage.goto(link);
  await expect(secondPage.locator("#sync-clash")).toBeVisible();
  await expect(secondPage.locator("#sync-clash-text")).toHaveText(
    "В этом браузере есть заметки, которых нет в серверной версии.",
  );

  await secondPage.locator("#sync-take-mine").click();
  await expect(status(secondPage)).toContainText("Сохранено на сервере");
  await expect(await firstAnswer(secondPage)).toHaveValue(
    "ответ второго браузера",
  );

  const versions = await openHistory(secondPage);
  await expect(versions.last()).toContainText("Заметки из браузера");

  // Третий браузер по той же ссылке видит именно то, что залил второй —
  // значит, состояние действительно уехало на сервер, а не осталось локальным.
  const third = await browser.newContext();
  const thirdPage = await third.newPage();
  await thirdPage.goto(link);
  await expect(await firstAnswer(thirdPage)).toHaveValue(
    "ответ второго браузера",
  );

  await first.close();
  await second.close();
  await third.close();
});

test("конфликт одновременной записи: «взять чужую» показывает правку первого", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(PAGE);
  const link = await enableSync(firstPage);

  // Второй браузер открывает ссылку ДО правки первого — его ревизия
  // фиксируется устаревшей и дальше не обновляется без явного действия.
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto(link);
  await expect(status(secondPage)).toContainText("Сохранено на сервере");

  await (await firstAnswer(firstPage)).fill("правка первого");
  await expect(status(firstPage)).toContainText("Сохранено на сервере");

  await (await firstAnswer(secondPage)).fill("правка второго");
  await expect(secondPage.locator("#sync-clash")).toBeVisible();
  await expect(secondPage.locator("#sync-clash-text")).toHaveText(
    "Документ изменили в другом месте, ваша правка не записана.",
  );
  await expect(status(secondPage)).toContainText("Расхождение версий");

  await secondPage.locator("#sync-take-theirs").click();
  await expect(await firstAnswer(secondPage)).toHaveValue("правка первого");

  await first.close();
  await second.close();
});

test("конфликт одновременной записи: «оставить мою» сохраняет правку второго, а правка первого остаётся в истории", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(PAGE);
  const link = await enableSync(firstPage);

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto(link);
  await expect(status(secondPage)).toContainText("Сохранено на сервере");

  await (await firstAnswer(firstPage)).fill("правка первого");
  await expect(status(firstPage)).toContainText("Сохранено на сервере");

  await (await firstAnswer(secondPage)).fill("правка второго");
  await expect(secondPage.locator("#sync-clash")).toBeVisible();

  await secondPage.locator("#sync-take-mine").click();
  await expect(status(secondPage)).toContainText("Сохранено на сервере");
  await expect(await firstAnswer(secondPage)).toHaveValue("правка второго");

  // Правка первого не пропала — она зафиксирована версией перед перезаписью
  // и доступна для возврата.
  const versions = await openHistory(secondPage);
  const overwritten = versions.filter({
    hasText: "Чужая правка перед перезаписью",
  });
  await expect(overwritten).toHaveCount(1);
  await overwritten.getByRole("button", { name: "Вернуть" }).click();
  await expect(await firstAnswer(secondPage)).toHaveValue("правка первого");

  await first.close();
  await second.close();
});
