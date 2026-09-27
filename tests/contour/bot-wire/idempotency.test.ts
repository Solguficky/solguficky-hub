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
} from "../../../apps/telegram-bot/testkit/index.js";
import { fillsMeetupForm, titleFor } from "./steps.js";

// Идемпотентность записи — угловые случаи 1–3 и кадр E-09. Итог читается из
// журнала Meetups, а не с экрана: двойное нажатие и успех снаружи неотличимы.
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

async function organizerInManagement() {
  const telegramUserId = freshTelegramUserId();
  const adminId = await direct.grantAdmin(telegramUserId);
  const organizer = startConversation(wire.bot, wire.calls, telegramUserId);
  await organizer.says("/start");
  await organizer.presses("Управление сходками");
  return { telegramUserId, adminId, organizer };
}

describe("идемпотентность по журналу Meetups", () => {
  it("случай 1: два быстрых нажатия «Создать сходку» дают один черновик", async () => {
    const { adminId, organizer } = await organizerInManagement();

    await organizer.pressesTwice("Создать сходку");

    const journal = await direct.journalOf(adminId);
    expect(journal.meetupIds).toHaveLength(1);
    expect(journal.events).toBe(1);
  });

  it("случай 2: повтор вызова Meetups с тем же ключом возвращает тот же черновик", async () => {
    const adminId = await direct.grantAdmin(freshTelegramUserId());
    const key = unusedMeetupId();

    const first = await direct.createDraftAsAdmin(adminId, key);
    const repeated = await direct.createDraftAsAdmin(adminId, key);

    expect(repeated).toEqual(first);
    expect(await direct.journalOf(adminId)).toEqual({
      meetupIds: [key],
      events: 1,
    });
  });

  it("случай 3: «Создать сходку» после перерисовки меню даёт новый черновик", async () => {
    const { adminId, organizer } = await organizerInManagement();

    await organizer.presses("Создать сходку");
    await organizer.presses("Управление сходками");
    await organizer.presses("Создать сходку");

    const journal = await direct.journalOf(adminId);
    expect(journal.meetupIds).toHaveLength(2);
    expect(journal.events).toBe(2);
  });

  it("E-09: двойное нажатие «Опубликовать» публикует один раз", async () => {
    const { telegramUserId, adminId, organizer } =
      await organizerInManagement();
    await organizer.presses("Создать сходку");
    await fillsMeetupForm(
      organizer,
      titleFor("Двойная публикация", telegramUserId),
    );
    const before = await direct.journalOf(adminId);

    await organizer.pressesTwice("Опубликовать");

    const after = await direct.journalOf(adminId);
    expect(after.meetupIds).toEqual(before.meetupIds);
    expect(after.events).toBe(before.events + 1);
    const [meetupId] = after.meetupIds;
    if (meetupId === undefined) throw new Error("сходки нет");
    expect(await direct.readAsAdmin(adminId, meetupId)).toMatchObject({
      visible: true,
    });
  });
});
