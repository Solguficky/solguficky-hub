import { afterEach, expect } from "vitest";
import { takeViolations } from "./screen-lint.js";

// Экран, нарушивший дизайн-код, роняет тест, который его отправил, — в любом
// наборе, где бот собран харнессом. Подключается через `setupFiles`.
afterEach(() => {
  expect(takeViolations()).toEqual([]);
});
