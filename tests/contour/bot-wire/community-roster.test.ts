import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  openBotWire,
  openDirectClients,
  type Person,
  readContourEnvironment,
  usernameFor,
} from "../../../apps/hub-bot/testkit/index.js";
import { memberAllowedBy, organizerAtStart } from "./steps.js";

// Состав сообщества по наборам прав (PER-547) против настоящего Identity: круг
// и модерация аукциона приходят из ListCommunityMembers и GetCommunityMember,
// а выдачу и снятие решает Identity. Поддельное нажатие участника без права
// бот пропускает к Identity, и тот отказывает, ничего не меняя.
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

function targetOf(person: Person, label: string): string {
  const button = person
    .history()
    .at(-1)
    ?.rows.flat()
    .find((candidate) => candidate.text === label);
  if (button === undefined) throw new Error(`кнопки «${label}» нет`);
  return button.target;
}

describe("состав сообщества", () => {
  it("администратор выдаёт и снимает модерацию с карточки, а поддельное нажатие получает отказ Identity", async () => {
    const { adminId, person: admin } = await organizerAtStart(wire, direct);
    const { telegramUserId, person: member } = await memberAllowedBy(
      wire,
      direct,
      adminId,
    );
    await member.says("/start");
    const name = `@${usernameFor(telegramUserId)}`;

    await admin.says("/manage");
    await admin.presses("Участники");
    await admin.presses("Состав сообщества");
    expect(admin.buttons()).toContain(name);
    await admin.presses("Гости");
    expect(admin.buttons()).not.toContain(name);
    await admin.presses("Участники");

    await admin.presses(name);
    expect(admin.sees()).toContain("Круг: участник");
    expect(admin.sees()).toContain("Модерация аукциона: нет");
    const grant = targetOf(admin, "Выдать модерацию");

    // Участник без права управлять составом жмёт подделанную «Выдать
    // модерацию» себе: кнопку бот не рисовал, право решает Identity.
    await member.says("/menu");
    await member.pressesRaw(grant);
    expect(member.sees()).toContain(
      "Управлять составом сообщества может только администратор.",
    );

    await admin.presses("‹ Состав");
    await admin.presses(name);
    expect(admin.sees()).toContain("Модерация аукциона: нет");

    await admin.presses("Выдать модерацию");
    expect(admin.sees()).toContain("Модерация аукциона: есть");
    await admin.presses("‹ Состав");
    await admin.presses("Модераторы");
    expect(admin.buttons()).toContain(name);

    await admin.presses(name);
    await admin.presses("Снять модерацию");
    expect(admin.sees()).toContain("Модерация аукциона: нет");
    await admin.presses("‹ Состав");
    expect(admin.buttons()).not.toContain(name);
  });
});
