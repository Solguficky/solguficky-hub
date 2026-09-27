import {
  afterAll,
  beforeAll,
  describe,
  expect,
  freshTelegramUserId,
  it,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
  startConversation,
  unusedMeetupId,
  usernameFor,
} from "../../../apps/telegram-bot/testkit/index.js";
import { fillsMeetupForm, titleFor } from "./steps.js";

// Кнопки на старых экранах — угловые случаи 4 и 5, кадры E-03 и E-04. Состояние
// меняется мимо бота, прямым вызовом Meetups, поэтому экран, который видит
// человек, устарел по-настоящему, а не подменой ответа.
const environment = readContourEnvironment();
const direct = openDirectClients(environment);
const wire = openBotWire(environment);

beforeAll(async () => {
  await direct.waitUntilReachable();
});

afterAll(() => {
  wire.close();
  direct.close();
});

/**
 * Опубликованная сходка и солегуфик, у которого уже открыт список с ней.
 * Смотрит не администратор: ему видна и снятая с публикации сходка.
 */
async function memberLookingAtPublishedMeetup(scenario: string) {
  const organizerTelegramId = freshTelegramUserId();
  const adminId = await direct.grantAdmin(organizerTelegramId);
  const organizer = startConversation(
    wire.bot,
    wire.calls,
    organizerTelegramId,
  );
  const title = titleFor(scenario, organizerTelegramId);
  await organizer.says("/start");
  await organizer.presses("Управление сходками");
  await organizer.presses("Создать сходку");
  await fillsMeetupForm(organizer, title);
  await organizer.presses("Опубликовать");
  const [meetupId] = (await direct.journalOf(adminId)).meetupIds;
  if (meetupId === undefined) throw new Error("сходка не заведена");

  const memberTelegramId = freshTelegramUserId();
  const username = usernameFor(memberTelegramId);
  await direct.allowUsername(adminId, username);
  const member = startConversation(wire.bot, wire.calls, memberTelegramId, {
    username,
  });
  await member.says("/start");
  await member.presses("Ближайшие сходки");
  expect(member.buttons()).toContain(title);
  return { adminId, meetupId, title, member };
}

describe("кнопки на старых экранах", () => {
  it("случай 4 и E-04: старая кнопка перерисовывает тот же экран по текущему состоянию", async () => {
    const { adminId, meetupId, title, member } =
      await memberLookingAtPublishedMeetup("Старое название");
    const renamed = `${title}, новое название`;
    await direct.renameAsAdmin(adminId, meetupId, renamed);
    const messages = member.messages();

    await member.presses(title);

    expect(member.sees()).toContain(renamed);
    expect(member.messages()).toBe(messages);
  });

  it("E-03: сходку сняли между списком и нажатием — ответ как у несуществующей", async () => {
    const { adminId, meetupId, title, member } =
      await memberLookingAtPublishedMeetup("Снятая");
    await direct.unpublishAsAdmin(adminId, meetupId);

    await member.presses(title);
    const unpublishedAnswer = member.sees();
    await member.opensLink(unusedMeetupId());

    expect(unpublishedAnswer).toBe(member.sees());
    // Совпадение двух ответов ничего не доказывает, если оба — кадр сбоя.
    expect(unpublishedAnswer).toContain("не найдена");
    expect(unpublishedAnswer).not.toContain(title);
  });

  it("случай 5: кнопка прошлого релиза не роняет обработку и открывает актуальный экран", async () => {
    const adminId = await direct.grantAdmin(freshTelegramUserId());
    const telegramUserId = freshTelegramUserId();
    const username = usernameFor(telegramUserId);
    await direct.allowUsername(adminId, username);
    const member = startConversation(wire.bot, wire.calls, telegramUserId, {
      username,
    });
    await member.says("/start");

    await member.pressesFromOlderRelease("Ближайшие сходки");
    expect(member.buttons()).toContain("Обновить");

    // Процесс жив: следующее нажатие обрабатывается как обычно.
    await member.presses("Назад");
    expect(member.buttons()).toContain("Ближайшие сходки");
  });
});
