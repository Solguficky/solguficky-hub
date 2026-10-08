import { afterEach, expect } from "vitest";
import { takeViolations } from "./screen-lint.js";

// Экран, нарушивший дизайн-код, роняет тест, который его отправил, — в любом
// наборе, где бот собран с записывающим трансформером. Подключается через
// `setupFiles`.
afterEach(() => {
  expect(takeViolations()).toEqual([]);
});
