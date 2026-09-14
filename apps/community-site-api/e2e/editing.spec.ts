// Слой 3: автосохранение, явная фиксация версии и откаты — то, что живёт на
// стыке страницы и обработчика и не проверяется ни модульными тестами, ни
// jsdom.
import { expect, test } from "@playwright/test";
import {
  enableSync,
  firstAnswer,
  openHistory,
  PAGE,
  status,
} from "./helpers.js";

test("автосохранение уезжает на сервер само и не растит историю версий", async ({
  page,
}) => {
  await page.goto(PAGE);
  await enableSync(page);

  const before = await openHistory(page);
  await expect(before).toHaveCount(1);
  await page.locator("#history-close").click();

  // Правка ничего не нажимает — уезжает сама через дебаунс.
  await (await firstAnswer(page)).fill("правка без нажатий");
  await expect(status(page)).toHaveText("Сохраняю…");
  await expect(status(page)).toContainText("Сохранено на сервере");

  const after = await openHistory(page);
  await expect(after).toHaveCount(1);
});

test("фиксация версии по кнопке добавляет запись со сводкой изменений", async ({
  page,
}) => {
  await page.goto(PAGE);
  await enableSync(page);

  await (await firstAnswer(page)).fill("важная заметка");
  await expect(status(page)).toContainText("Сохранено на сервере");

  const versions = await openHistory(page);
  await page.locator("#history-label").fill("Перед обсуждением");
  await page.locator("#history-commit").click();

  await expect(versions).toHaveCount(2);
  const committed = versions.last();
  await expect(committed).toContainText("Перед обсуждением");
  // Сводку считает страница по разнице с предыдущей версией — сверяем по
  // существу («изменено — заметок: 1»), а не побуквенно.
  await expect(committed).toContainText("изменено");
  await expect(committed).toContainText("заметок: 1");
});

// Самый недобрый сценарий из всех: человек печатал, версию не фиксировал —
// автосохранение унесло правку на сервер, но в истории её нет, — и жмёт
// «Вернуть». Возврат обязан сначала убрать несохранённое в историю, иначе оно
// исчезнет вместе с нажатием.
test("возврат не теряет автосохранённое: оно уходит в историю снимком", async ({
  page,
}) => {
  await page.goto(PAGE);
  await enableSync(page);
  const answer = await firstAnswer(page);

  await answer.fill("черновик без версии");
  await expect(status(page)).toContainText("Сохранено на сервере");

  const versions = await openHistory(page);
  await expect(versions).toHaveCount(1);
  await versions
    .filter({ hasText: "Начальная версия" })
    .getByRole("button", { name: "Вернуть" })
    .click();
  // Две новые записи: снимок черновика и сам возврат.
  await expect(versions).toHaveCount(3);
  await page.locator("#history-close").click();
  await expect(answer).toHaveValue("");

  // И черновик возвращается тем же действием, что и любая версия.
  await openHistory(page);
  await versions
    .filter({ hasText: "Состояние перед возвратом" })
    .getByRole("button", { name: "Вернуть" })
    .click();
  await page.locator("#history-close").click();
  await expect(answer).toHaveValue("черновик без версии");
});

test("возврат к версии и возврат самого возврата не теряют историю", async ({
  page,
}) => {
  await page.goto(PAGE);
  await enableSync(page);
  const answer = await firstAnswer(page);

  // Обе версии фиксируются явно: черновик автосохранения версией не
  // становится, и «отменить откат» иначе не к чему было бы возвращать.
  await answer.fill("исходный текст");
  await expect(status(page)).toContainText("Сохранено на сервере");
  let versions = await openHistory(page);
  await page.locator("#history-label").fill("Исходный текст");
  await page.locator("#history-commit").click();
  await expect(versions).toHaveCount(2);
  await page.locator("#history-close").click();

  await answer.fill("изменённый текст");
  await expect(status(page)).toContainText("Сохранено на сервере");
  versions = await openHistory(page);
  await page.locator("#history-label").fill("Изменённый текст");
  await page.locator("#history-commit").click();
  await expect(versions).toHaveCount(3);

  // Возврат к исходной версии: поле снова показывает прежний текст.
  await versions
    .filter({ hasText: "Исходный текст" })
    .getByRole("button", { name: "Вернуть" })
    .click();
  await expect(versions).toHaveCount(4);
  await page.locator("#history-close").click();
  await expect(answer).toHaveValue("исходный текст");

  // Возврат возврата: версия с изменённым текстом никуда не делась и
  // остаётся доступной — история только растёт, ничего не стирается.
  versions = await openHistory(page);
  await versions
    .filter({ hasText: "Изменённый текст" })
    .getByRole("button", { name: "Вернуть" })
    .click();
  await expect(versions).toHaveCount(5);
  await page.locator("#history-close").click();
  await expect(answer).toHaveValue("изменённый текст");
});
