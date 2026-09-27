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
  unreachableUrl,
} from "../../../apps/telegram-bot/testkit/index.js";

// Кадр E-05: сбой соседа и пустой результат — разные экраны. Identity
// настоящий, Meetups недоступен: отказ проходит настоящий транспорт и
// настоящее отображение кода UNAVAILABLE.
const environment = readContourEnvironment();
const direct = openDirectClients(environment);
const wire = openBotWire({ ...environment, meetupsUrl: unreachableUrl });

beforeAll(async () => {
  await direct.waitUntilReachable();
});

afterAll(() => {
  wire.close();
  direct.close();
});

describe("провод бота при недоступном Meetups", () => {
  it("показывает E-05, а не пустой список", async () => {
    const telegramUserId = freshTelegramUserId();
    await direct.grantAdmin(telegramUserId);
    const person = startConversation(wire.bot, wire.calls, telegramUserId);

    await person.says("/start");
    await person.presses("Ближайшие сходки");

    expect(person.sees()).toContain("Не получилось загрузить сходки");
    expect(person.sees()).not.toContain("Пока ни одной запланированной сходки");
  });
});
