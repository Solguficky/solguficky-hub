// Слой 3: сценарии в настоящем браузере. Проверяется то, что не видно ни
// модульным тестам, ни jsdom: страница, обработчик и хранилище работают как
// одно целое, а человек доходит от пустой страницы до перенесённых заметок.
import { expect, test } from "@playwright/test";
import {
  enableSync,
  firstAnswer,
  openHistory,
  PAGE,
  status,
} from "./helpers.js";

test("документ заводится кнопкой и сразу получает ссылку и первую версию", async ({
  page,
}) => {
  await page.goto(PAGE);
  await expect(status(page)).toHaveText("Только в этом браузере");
  await expect(page.locator("#sync-history")).toBeHidden();

  await enableSync(page);

  await expect(page.locator("#sync-history")).toBeVisible();
  await expect(page.locator("#sync-share")).toBeVisible();

  const versions = await openHistory(page);
  await expect(versions).toHaveCount(1);
  await expect(versions.first()).toContainText("Начальная версия");
});

test("заполненное доезжает до второго браузера по ссылке", async ({
  page,
  browser,
}) => {
  await page.goto(PAGE);
  await (await firstAnswer(page)).fill("ответ первого редактора");
  const link = await enableSync(page);

  // Второй человек открывает ту же ссылку в чистом браузере: своего
  // хранилища у него нет, и всё, что он видит, пришло с сервера.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(link);

  await expect(await firstAnswer(otherPage)).toHaveValue(
    "ответ первого редактора",
  );
  // Пропуск сделал своё дело и в адресной строке больше не висит.
  expect(new URL(otherPage.url()).searchParams.get("doc")).toBeNull();

  await other.close();
});
