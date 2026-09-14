// Слой 3: как страница выглядит, а не что она хранит — тема, узкий экран и
// печатная версия. Печать проверяется отдельно, потому что заполненные поля
// управления должны уступить место тексту, а не пропасть вместе с ним.
import { expect, test } from "@playwright/test";
import { firstAnswer, PAGE } from "./helpers.js";

test("тема по умолчанию следует системной настройке, светлой и тёмной", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(PAGE);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("на ширине 375 пикселей нет горизонтальной прокрутки", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(PAGE);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("печатная версия показывает заполненную оценку и текст ответа", async ({
  page,
}) => {
  await page.goto(PAGE);

  // Карточки фич свёрнуты по умолчанию (страница схлопывает их же
  // скриптом на старте): выбор в скрытом `<select>` недоступен, пока
  // карточку не раскрыть.
  await page.getByRole("button", { name: "Раскрыть всё" }).click();

  const slot = page.locator(".slot").first();
  await slot.locator("select").selectOption({ index: 1 });
  const selectedText = await slot.locator("select").inputValue();

  const note = page.locator("[data-note]").first();
  await (await firstAnswer(page)).fill("ответ для печати");

  // Перезагрузка возвращает страницу в то состояние, в каком её застаёт
  // печать у обычного читателя: значения на месте (они в браузере), а
  // карточки снова свёрнуты скриптом старта.
  await page.reload();
  await page.emulateMedia({ media: "print" });
  // Печатная копия видна только в раскрытой карточке, и раскрывает их сама
  // страница по событию `beforeprint`. `emulateMedia` меняет только media
  // query и событий не шлёт, поэтому шлём его так же, как браузер.
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));

  // В печати элемент управления уступает место обычному тексту с тем же
  // значением.
  const slotPrint = slot.locator(".slot-print");
  await expect(slotPrint).toBeVisible();
  await expect(slotPrint).toHaveText(selectedText);

  const answerPrint = note.locator(".answer-print");
  await expect(answerPrint).toBeVisible();
  await expect(answerPrint).toContainText("ответ для печати");
});
