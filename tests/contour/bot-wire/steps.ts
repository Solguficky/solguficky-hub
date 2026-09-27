import type { Person } from "../../../apps/telegram-bot/testkit/index.js";

// Шаги, которые сценарии провода проходят одинаково. Файл не `*.test.ts`, и
// vitest его как набор не собирает.

/**
 * Администратор отвечает на вопросы формы создания и доходит до предпросмотра.
 * Дата — через год: сегодняшняя граница «прошедшей» даты сценарий не касается.
 */
export async function fillsMeetupForm(
  organizer: Person,
  title: string,
): Promise<void> {
  const year = new Date().getUTCFullYear() + 1;
  await organizer.says(title);
  await organizer.says(`12.06.${year} 19:00`);
  await organizer.says("Циферблат");
  await organizer.says("Берём свои игры");
}

/**
 * Название на прогон: база контура общая на все файлы и живёт дольше прогона в
 * режиме `just contour-up`, поэтому чужая сходка с тем же названием в списке
 * сделала бы проверку видимости бессмысленной.
 */
export function titleFor(scenario: string, telegramUserId: bigint): string {
  return `${scenario} ${telegramUserId}`;
}
