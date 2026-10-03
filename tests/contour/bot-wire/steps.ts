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
 * Администратор называет сходку и заполняет поля с черновика: кнопка поля,
 * затем ответ на её вопрос. В конце на экране черновик с «Опубликовать».
 * Дата — через год: сегодняшняя граница «прошедшей» даты сценарий не касается,
 * и среди заготовок такой даты нет — её пишут текстом через «Другая дата».
 */
export async function fillsMeetupForm(
  organizer: Person,
  title: string,
): Promise<void> {
  const year = new Date().getUTCFullYear() + 1;
  await organizer.says(title);
  await organizer.presses("Дата и время");
  await organizer.presses("Другая дата");
  await organizer.says(`12.06.${year} 19:00`);
  await organizer.presses("Место");
  await organizer.says("Циферблат");
  await organizer.presses("Описание");
  await organizer.says("Берём свои игры");
}

/**
 * Подпись кнопки сходки в списке: дата из `fillsMeetupForm` и название. Год в
 * ней есть, потому что дата сценария — в следующем году.
 */
export function listedAs(title: string): string {
  return `12 июня ${new Date().getUTCFullYear() + 1} · ${title}`;
}

/**
 * Название на прогон: база контура общая на все файлы и живёт дольше прогона в
 * режиме `just contour-up`, поэтому чужая сходка с тем же названием в списке
 * сделала бы проверку видимости бессмысленной.
 */
export function titleFor(scenario: string, telegramUserId: bigint): string {
  return `${scenario} ${telegramUserId}`;
}
