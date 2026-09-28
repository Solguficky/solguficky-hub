import {
  freshTelegramUserId,
  type openBotWire,
  type openDirectClients,
  type Person,
  startConversation,
  usernameFor,
} from "../../../apps/telegram-bot/testkit/index.js";

// Шаги, которые сценарии провода проходят одинаково. Файл не `*.test.ts`, и
// vitest его как набор не собирает.

type Wire = ReturnType<typeof openBotWire>;
type Direct = ReturnType<typeof openDirectClients>;

/** Администратор с настоящей ролью, уже открывший бота. */
export async function organizerAtStart(wire: Wire, direct: Direct) {
  const telegramUserId = freshTelegramUserId();
  const adminId = await direct.grantAdmin(telegramUserId);
  const person = startConversation(wire.bot, wire.calls, telegramUserId);
  await person.says("/start");
  return { telegramUserId, adminId, person };
}

/**
 * Солегуфик из сценария среза: ник заранее внесён администратором в
 * whitelist, и роль `member` он получит на своём первом `/start`.
 */
export async function memberAllowedBy(
  wire: Wire,
  direct: Direct,
  adminId: string,
) {
  const telegramUserId = freshTelegramUserId();
  const username = usernameFor(telegramUserId);
  await direct.allowUsername(adminId, username);
  const person = startConversation(wire.bot, wire.calls, telegramUserId, {
    username,
  });
  return { telegramUserId, person };
}

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
