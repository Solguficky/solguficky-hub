import {
  afterAll,
  beforeAll,
  describe,
  expect,
  freshTelegramUserId,
  it,
  meetupIdFromStartLink,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
  startConversation,
} from "../../../apps/telegram-bot/testkit/index.js";

// Требование 1 из RFC-012: сценарий «создал и опубликовал» проходится без
// единой телеграмовской структуры, против настоящих Identity и Meetups.
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

describe("провод бота", () => {
  it("администратор создаёт и публикует сходку, и Meetups хранит её видимой", async () => {
    const telegramUserId = freshTelegramUserId();
    const identityId = await direct.grantAdmin(telegramUserId);
    const organizer = startConversation(wire.bot, wire.calls, telegramUserId);
    const year = new Date().getUTCFullYear() + 1;

    await organizer.says("/start");
    await organizer.presses("Управление сходками");
    await organizer.presses("Создать сходку");
    await organizer.says("Настолки в контуре");
    await organizer.says(`12.06.${year} 19:00`);
    await organizer.says("Циферблат");
    await organizer.says("Берём свои игры");
    await organizer.presses("Опубликовать");

    expect(organizer.sees()).toContain("Сходка создана");
    const stored = await direct.readAsAdmin(
      identityId,
      meetupIdFromStartLink(organizer.sees()),
    );
    expect(stored).toEqual({
      title: "Настолки в контуре",
      venue: "Циферблат",
      description: "Берём свои игры",
      visible: true,
    });
  });
});
