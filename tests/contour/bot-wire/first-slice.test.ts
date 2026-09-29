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
  unusedMeetupId,
} from "../../../apps/telegram-bot/testkit/index.js";
import {
  fillsMeetupForm,
  memberAllowedBy,
  organizerAtStart,
  titleFor,
} from "./steps.js";

// Сценарий первого среза целиком (first-slice.md, «Сценарий») и его
// отрицательная половина: до публикации сходка для солегуфика не наблюдаема ни
// списком, ни прямой ссылкой. Плюс кадр E-01: вход в управление
// солегуфик не видит, а отказ в праве по оставшейся в чате кнопке приходит от
// Meetups, а не от проверки в боте.
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

describe("сценарий первого среза", () => {
  it("солегуфик не видит черновик ни списком, ни ссылкой, а опубликованную сходку видит", async () => {
    const { adminId, person: organizer } = await organizerAtStart(wire, direct);
    const { telegramUserId, person: member } = await memberAllowedBy(
      wire,
      direct,
      adminId,
    );
    const title = titleFor("Срез", telegramUserId);

    await member.says("/start");
    await member.presses("Ближайшие сходки");
    expect(member.sees()).not.toContain(title);

    await organizer.presses("Управление сходками");
    await organizer.presses("Создать сходку");
    await fillsMeetupForm(organizer, title);
    expect(organizer.sees()).toContain("Проверь сходку");
    const [draftId] = (await direct.journalOf(adminId)).meetupIds;
    if (draftId === undefined) throw new Error("черновик не заведён");

    // Отрицательная половина: черновик уже в Meetups, но для солегуфика его нет.
    await member.presses("Обновить");
    expect(member.sees()).not.toContain(title);
    expect(member.buttons()).not.toContain(title);
    await member.opensLink(draftId);
    const hiddenAnswer = member.sees();
    await member.opensLink(unusedMeetupId());
    expect(hiddenAnswer).toBe(member.sees());
    // Совпадение двух ответов ничего не доказывает, если оба — кадр сбоя.
    expect(hiddenAnswer).toContain("не найдена");
    expect(hiddenAnswer).not.toContain(title);

    await organizer.presses("Опубликовать");
    expect(organizer.sees()).toContain("Сходка создана");

    // P-03 и P-04: тот же человек видит сходку в списке и её карточку.
    await member.says("/start");
    await member.presses("Ближайшие сходки");
    expect(member.buttons()).toContain(title);
    await member.presses(title);
    expect(member.sees()).toContain(title);
    expect(member.sees()).toContain("Циферблат");
    expect(member.sees()).toContain("Берём свои игры");
    expect(await direct.readAsAdmin(adminId, draftId)).toMatchObject({
      visible: true,
    });
  });

  it("солегуфик не видит входа в управление", async () => {
    const adminId = await direct.grantAdmin(freshTelegramUserId());
    const { person: member } = await memberAllowedBy(wire, direct, adminId);

    await member.says("/start");

    expect(member.buttons()).toContain("Ближайшие сходки");
    expect(member.buttons()).not.toContain("Управление сходками");
  });

  it("E-01: создать сходку после отзыва роли отказывает Meetups, и журнал не растёт", async () => {
    const adminId = await direct.grantAdmin(freshTelegramUserId());
    const { telegramUserId, person } = await memberAllowedBy(
      wire,
      direct,
      adminId,
    );
    // Роль `member` человек получает первым `/start`: без неё после отзыва он
    // упёрся бы в кадр ожидания доступа, а не в Meetups.
    await person.says("/start");
    await direct.grantAdmin(telegramUserId);
    await person.says("/start");
    await person.presses("Управление сходками");
    const personId = await direct.identityOf(telegramUserId);
    await direct.revokeAdmin(personId);

    // Меню осталось в чате, а кнопку внутри него бот не сторожит: право решает
    // Meetups, и отказ звучит без имени сервиса.
    await person.presses("Создать сходку");

    expect(person.sees()).toBe("Это действие тебе недоступно.");
    expect(await direct.journalOf(personId)).toEqual({
      meetupIds: [],
      events: 0,
    });
  });
});
