import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  meetupIdFromStartLink,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
} from "../../../apps/telegram-bot/testkit/index.js";
import { fillsMeetupForm, organizerAtStart, titleFor } from "./steps.js";

// Материалы сходки через настоящий Meetups. Команды материала несут
// `expected_version`, которую Meetups проверяет только значением, а тип
// init-формы клиента её не требует: без этого провода бот неделю слал их без
// версии, и расхождение нашёл лишь живой прогон (наблюдение 2026-09-27, PER-393).
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
 * Опубликованная сходка, у которой администратор открыл материалы и дошёл до
 * подтверждения пересланного поста канала.
 */
async function organizerConfirmingMaterial(scenario: string) {
  const {
    telegramUserId,
    adminId,
    person: organizer,
  } = await organizerAtStart(wire, direct);
  const title = titleFor(scenario, telegramUserId);
  await organizer.presses("Управление сходками");
  await organizer.presses("Создать сходку");
  await fillsMeetupForm(organizer, title);
  await organizer.presses("Опубликовать");
  const meetupId = meetupIdFromStartLink(organizer.sees());

  await organizer.opensLink(meetupId);
  await organizer.presses("Материалы (0)");
  await organizer.presses("Прикрепить материал");
  await organizer.forwardsChannelPost("solguficky_contour", 77);
  await organizer.says("Программа вечера");
  expect(organizer.sees()).toContain("Прикрепить материал?");
  return { adminId, meetupId, organizer };
}

describe("материалы сходки", () => {
  it("администратор прикрепляет и убирает материал, и Meetups хранит это", async () => {
    const { adminId, meetupId, organizer } =
      await organizerConfirmingMaterial("материал");

    await organizer.presses("Прикрепить");

    expect(organizer.sees()).toContain("1. Программа вечера");
    expect(await direct.materialsAsAdmin(adminId, meetupId)).toEqual([
      "Программа вечера",
    ]);

    await organizer.presses("Убрать");
    await organizer.presses("Да, убрать");

    expect(organizer.sees()).toContain("Пока ничего не прикреплено.");
    expect(await direct.materialsAsAdmin(adminId, meetupId)).toEqual([]);
  });

  it("прикрепление по устаревшей карточке даёт кадр конфликта и повторяется по свежей", async () => {
    const { adminId, meetupId, organizer } = await organizerConfirmingMaterial(
      "материал поверх правки",
    );
    await direct.renameAsAdmin(adminId, meetupId, "Переименована мимо бота");

    await organizer.presses("Прикрепить");

    expect(organizer.sees()).toContain("Сходка уже изменилась.");
    expect(await direct.materialsAsAdmin(adminId, meetupId)).toEqual([]);

    await organizer.presses("Прикрепить");

    expect(organizer.sees()).toContain("1. Программа вечера");
    expect(await direct.materialsAsAdmin(adminId, meetupId)).toEqual([
      "Программа вечера",
    ]);
  });
});
