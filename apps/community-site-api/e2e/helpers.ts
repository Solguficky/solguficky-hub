// Общие шаги сценариев: то, что человек делает на странице руками. Селекторы
// собраны здесь, чтобы правка разметки чинилась в одном месте, а не в каждом
// сценарии.
import { expect, type Page } from "@playwright/test";

export const PAGE = "/auction-2026";

export const status = (page: Page) => page.locator("#sync-state");

/** Поле ответа на первый вопрос страницы. Лежит в свёрнутом `<details>`, и
 *  пока его не раскрыть, оно скрыто и от человека, и от браузера. Заполненное
 *  поле страница раскрывает сама. */
export const firstAnswer = async (page: Page) => {
  const answer = page.locator("[data-note] details.answer").first();
  if (!(await answer.evaluate((node: HTMLDetailsElement) => node.open))) {
    await answer.locator("summary").click();
  }
  return answer.locator("textarea");
};

/** Заводит документ и возвращает ссылку на него — ту самую, которую человек
 *  передаёт второму редактору. */
export const enableSync = async (page: Page): Promise<string> => {
  await page.locator("#sync-enable").click();
  await expect(status(page)).toContainText("Сохранено на сервере");
  const link = await page.locator("#sync-link").inputValue();
  expect(link).toContain("?doc=");
  return link;
};

/** Открывает диалог истории и отдаёт список версий. */
export const openHistory = async (page: Page) => {
  await page.locator("#sync-history").click();
  return page.locator("#history-list li");
};
