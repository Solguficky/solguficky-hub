import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  openBotWire,
  openDirectClients,
  readContourEnvironment,
  unusedMeetupId,
} from "../../../apps/hub-bot/testkit/index.js";
import {
  fillsMeetupForm,
  listedAs,
  memberAllowedBy,
  organizerAtStart,
  titleFor,
} from "./steps.js";

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
  const {
    telegramUserId,
    adminId,
    person: organizer,
  } = await organizerAtStart(wire, direct);
  const title = titleFor(scenario, telegramUserId);
  await organizer.says("/manage");
  await organizer.presses("Сходки и объявления");
  await organizer.presses("Создать сходку");
  await fillsMeetupForm(organizer, title);
  await organizer.presses("Опубликовать");
  await organizer.presses("✔️ Да, опубликовать сходку");
  const [meetupId] = (await direct.journalOf(adminId)).meetupIds;
  if (meetupId === undefined) throw new Error("сходка не заведена");

  const { person: member } = await memberAllowedBy(wire, direct, adminId);
  await member.says("/start");
  expect(member.buttons()).toContain(listedAs(title));
  return { adminId, meetupId, title, member };
}

describe("кнопки на старых экранах", () => {
  it("случай 4 и E-04: старая кнопка перерисовывает тот же экран по текущему состоянию", async () => {
    const { adminId, meetupId, title, member } =
      await memberLookingAtPublishedMeetup("Старое название");
    const renamed = `${title}, новое название`;
    await direct.renameAsAdmin(adminId, meetupId, renamed);
    const messages = member.messages();

    await member.presses(listedAs(title));

    expect(member.sees()).toContain(renamed);
    expect(member.messages()).toBe(messages);
  });

  it("E-03: сходку сняли между списком и нажатием — ответ как у несуществующей", async () => {
    const { adminId, meetupId, title, member } =
      await memberLookingAtPublishedMeetup("Снятая");
    await direct.unpublishAsAdmin(adminId, meetupId);

    await member.presses(listedAs(title));
    const unpublishedAnswer = member.sees();
    await member.opensLink(unusedMeetupId());

    expect(unpublishedAnswer).toBe(member.sees());
    // Совпадение двух ответов ничего не доказывает, если оба — кадр сбоя.
    expect(unpublishedAnswer).toContain("не найдена");
    expect(unpublishedAnswer).not.toContain(title);
  });

  it("случай 5: кнопка прошлого релиза не роняет обработку и открывает актуальный экран", async () => {
    // Вход в управление есть только у администратора (PER-396).
    const { person: organizer } = await organizerAtStart(wire, direct);

    // Кнопка, чей обычный экран — меню управления, а не список: иначе
    // исполненная как обычная она дала бы тот же экран, что и устаревшая.
    await organizer.pressesFromOlderRelease("Управление");
    expect(organizer.sees()).toMatch(/^Сходки/);
    expect(organizer.buttons()).not.toContain("Создать сходку");

    // Процесс жив: следующее нажатие обрабатывается как обычно.
    await organizer.presses("Архив");
    expect(organizer.buttons()).toContain("‹ Сходки");
  });
});
