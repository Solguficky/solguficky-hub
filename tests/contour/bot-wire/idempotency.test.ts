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
} from "../../../apps/hub-bot/testkit/index.js";
import { fillsMeetupForm, organizerAtStart, titleFor } from "./steps.js";

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
  const {
    telegramUserId,
    adminId,
    person: organizer,
  } = await organizerAtStart(wire, direct);
  await organizer.says("/manage");
  await organizer.presses("Сходки и объявления");
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
    // Перерисовка «Управления»: оно правит своё сообщение, и второй вход в него
    // идёт новым сообщением по команде `/manage`.
    await organizer.says("/manage");
    await organizer.presses("Сходки и объявления");
    await organizer.presses("Создать сходку");

    const journal = await direct.journalOf(adminId);
    expect(journal.meetupIds).toHaveLength(2);
    expect(journal.events).toBe(2);
  });

  it("E-09: двойное нажатие «Да, опубликовать сходку» публикует один раз", async () => {
    const { telegramUserId, adminId, organizer } =
      await organizerInManagement();
    await organizer.presses("Создать сходку");
    await fillsMeetupForm(
      organizer,
      titleFor("Двойная публикация", telegramUserId),
    );
    const before = await direct.journalOf(adminId);

    await organizer.presses("Опубликовать");
    await organizer.pressesTwice("✔️ Да, опубликовать сходку");

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
