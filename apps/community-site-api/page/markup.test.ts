// Слой 4: доступность и разметка. Проверяются все страницы, опубликованные в
// `docs/published/**/index.html` — список составляется обходом каталога
// (`findPublishedPages`), а не перечислением руками, чтобы новая страница
// подхватилась сама. `axe-core` в jsdom не умеет правила, которым нужна
// настоящая вёрстка (`color-contrast` — единственное такое здесь), и оно
// отключено явно в каждом прогоне; остальные правила проверяют разметку, а
// не рендер, и jsdom для них достаточно надёжен.
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { HtmlValidate } from "html-validate";
import { describe, expect, it, vi } from "vitest";
import {
  AUCTION_PAGE_PATH,
  type AxeRunner,
  findPublishedPages,
  loadAxe,
  loadPublishedPage,
  PUBLISHED_DIR,
  type StaticPage,
} from "./load.js";

const pages = findPublishedPages().map((filePath) => ({
  filePath,
  rel: relative(PUBLISHED_DIR, filePath).split(sep).join("/"),
}));

// Полный разбор страницы (особенно архивной презентации на 5000+ строк) и
// впрыск axe в её реальность — не бесплатная операция. Большинство проверок
// этого слоя друг друга не портят (только читают DOM), поэтому грузим и
// сканируем каждую страницу один раз и переиспользуем между `describe`, а не
// заново на каждый `it` — иначе тесты этого файла упираются в дефолтный
// таймаут vitest под нагрузкой.
const pageCache = new Map<string, StaticPage>();
const getPage = (filePath: string): StaticPage => {
  const cached = pageCache.get(filePath);
  if (cached) return cached;
  const page = loadPublishedPage(filePath);
  pageCache.set(filePath, page);
  return page;
};

const axeCache = new Map<string, AxeRunner>();
const getAxe = (filePath: string): AxeRunner => {
  const cached = axeCache.get(filePath);
  if (cached) return cached;
  const axe = loadAxe(getPage(filePath));
  axeCache.set(filePath, axe);
  return axe;
};

// Разбор архивной презентации (5000+ строк) и полный прогон axe под нагрузкой
// не укладываются в дефолтные 5 секунд vitest даже с кэшем выше.
vi.setConfig({ testTimeout: 40_000 });

// Гарантия для самого списка: если обход каталога вдруг ничего не нашёл,
// остальные проверки молча превратились бы в пустые `describe` без единого
// `it` — лучше упасть явно.
it("на сайте есть хотя бы одна опубликованная страница", () => {
  expect(pages.length).toBeGreaterThan(0);
});

describe("html-validate: разметка проходит рекомендованный набор правил", () => {
  // Все три страницы репозитория используют строчный `<!doctype html>`
  // (см. первую строку каждой из них) — это единообразный стиль репозитория,
  // а не оплошность; правило `doctype-style` в рекомендованном наборе просто
  // предпочитает заглавный вариант и к доступности не имеет отношения.
  // Отключаем именно это стилистическое требование, а не проверку целиком.
  const config = {
    extends: ["html-validate:recommended"],
    rules: { "doctype-style": "off" as const },
  };

  // Известные находки страниц: правило и точное число нарушений. Сверяется
  // весь состав, а не факт «ошибки есть»: иначе новое нарушение спряталось бы
  // за старым, а исправленное осталось бы числиться вечно. Расхождение в любую
  // сторону — сигнал, и таблица правится вместе с разметкой.
  //
  // `unique-landmark`: каждый `<aside class="note">` ARIA-маппится в ориентир
  // complementary, и ни у одного нет различающего имени. Для читателя экранного
  // диктора это полсотни одинаково названных ориентиров; правится разметкой
  // страницы и ждёт решения владельца.
  //
  // `no-implicit-button-type` и `valid-id`: архивная презентация — выгрузка
  // Marp/bespoke.js. Она заморожена как историческое свидетельство и руками не
  // редактируется.
  const knownFindings: Record<string, Record<string, number>> = {
    "auction-2026/index.html": { "unique-landmark": 55 },
    "archive/auction-module/index.html": {
      "no-implicit-button-type": 4,
      "valid-id": 1,
    },
  };

  for (const { filePath, rel } of pages) {
    it(`${rel} — состав нарушений не изменился`, async () => {
      const html = readFileSync(filePath, "utf8");
      const report = await new HtmlValidate(config).validateString(html);
      const counts: Record<string, number> = {};
      for (const result of report.results) {
        for (const message of result.messages) {
          // severity 2 — ошибка; предупреждения этот слой не гейтит.
          if (message.severity !== 2) continue;
          counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
        }
      }
      expect(counts).toEqual(knownFindings[rel] ?? {});
    });
  }
});

describe("все id на странице уникальны", () => {
  for (const { filePath, rel } of pages) {
    it(rel, () => {
      const { document } = getPage(filePath);
      const ids = [...document.querySelectorAll("[id]")].map(
        (element) => element.id,
      );
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
      }
      expect([...duplicates]).toEqual([]);
    });
  }
});

describe("у интерактивных элементов есть доступное имя", () => {
  for (const { filePath, rel } of pages) {
    it(rel, async () => {
      const page = getPage(filePath);
      const axe = getAxe(filePath);
      // button-name/select-name/label покрывают ровно три вида элементов из
      // плана: кнопки, select и textarea (у textarea нет отдельного правила —
      // её покрывает общий "label" для полей формы).
      const results = await axe.run(page.document, {
        runOnly: ["button-name", "select-name", "label"],
      });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
    });
  }
});

describe("иерархия заголовков без пропусков уровней", () => {
  for (const { filePath, rel } of pages) {
    it(rel, async () => {
      const page = getPage(filePath);
      const axe = getAxe(filePath);
      const results = await axe.run(page.document, {
        runOnly: ["heading-order"],
      });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
    });
  }
});

describe("у документа есть lang, title и meta viewport", () => {
  for (const { filePath, rel } of pages) {
    it(rel, () => {
      const { document } = getPage(filePath);
      expect(document.documentElement.getAttribute("lang")).toBeTruthy();
      expect(document.title.trim().length).toBeGreaterThan(0);
      const viewport = document.querySelector('meta[name="viewport"]');
      expect(viewport).not.toBeNull();
      expect(viewport?.getAttribute("content")).toMatch(/width=device-width/);
    });
  }
});

describe("axe-core не находит нарушений уровня serious или critical", () => {
  for (const { filePath, rel } of pages) {
    // Без `runOnly` axe проверяет весь набор правил — на «Аукционе 2026» (полсотни
    // карточек фич, десятки заметок) это самый долгий прогон в файле; под
    // нагрузкой упирается даже в общий файловый таймаут, поэтому у него свой,
    // с запасом.
    it(rel, async () => {
      const page = getPage(filePath);
      const axe = getAxe(filePath);
      const results = await axe.run(page.document, {
        // Цвет и контраст в jsdom не считаются: нет реального рендера, нет
        // геометрии текста и фона — правило технически неприменимо, а не
        // «пройдено».
        rules: { "color-contrast": { enabled: false } },
      });
      const serious = results.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      );
      expect(
        serious.map((violation) => `${violation.id} (${violation.impact})`),
      ).toEqual([]);
    }, 120_000);
  }
});

// Диалог истории версий есть только на «Аукционе 2026» — у двух других
// опубликованных страниц (индекс сайта и архивная презентация) элемента
// <dialog> вовсе нет, проверять там нечего. Диалог здесь открывается и
// закрывается по-настоящему (в отличие от остальных проверок этого файла),
// поэтому страница берётся не из общего кэша, а своя — чтобы не оставить
// открытый диалог в странице, которую переиспользуют другие `describe`.
describe("диалог истории версий", () => {
  it("связан с заголовком через aria-labelledby и закрывается кнопкой", () => {
    const { document, window } = loadPublishedPage(AUCTION_PAGE_PATH);
    const dialog = document.getElementById("history-dialog");
    if (!dialog) throw new Error("#history-dialog не найден");
    if (!(dialog instanceof window.HTMLDialogElement)) {
      throw new Error("#history-dialog — не <dialog>");
    }

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = labelledBy ? document.getElementById(labelledBy) : null;
    expect(heading?.textContent?.trim()).toBe("История версий");

    const closeButton = document.getElementById("history-close");
    if (!(closeButton instanceof window.HTMLButtonElement)) {
      throw new Error("#history-close не найдена или не кнопка");
    }

    dialog.showModal();
    expect(dialog.hasAttribute("open")).toBe(true);
    closeButton.click();
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});

// Единственная декоративная графика на опубликованных страницах — ручка
// перетаскивания приоритета (`.grip`); её создаёт клиентский скрипт
// «Аукциона 2026» вместе со строкой приоритета, поэтому проверяется общая
// закэшированная страница — тем же прогоном, что и остальные read-only
// проверки этого файла.
describe("декоративная графика скрыта от скринридера", () => {
  it("ручка перетаскивания приоритета помечена aria-hidden", () => {
    const { document } = getPage(AUCTION_PAGE_PATH);
    const grips = [...document.querySelectorAll(".priorities .grip")];
    expect(grips.length).toBeGreaterThan(0);
    for (const grip of grips) {
      expect(grip.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
