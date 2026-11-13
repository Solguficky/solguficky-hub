import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  meetupIdFromStartLink,
  openBotWire,
  openDirectClients,
  type Person,
  readContourEnvironment,
  usernameFor,
} from "../../../apps/hub-bot/testkit/index.js";
import {
  fillsMeetupForm,
  listedAs,
  memberAllowedBy,
  organizerAtStart,
  titleFor,
} from "./steps.js";

// ADR-076 и PER-748: участник без набора `admin` заводит сходку правом
// `organize_meetups`, которое идёт с кругом участника, и ведёт её как
// организатор из состава. Всё — против настоящих Identity и Meetups.
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

// `callback_data` кнопки последнего экрана: подделанное нажатие второго
// участника повторяет кнопку, которую бот нарисовал организатору.
function targetOf(person: Person, label: string): string {
  const button = person
    .history()
    .at(-1)
    ?.rows.flat()
    .find((candidate) => candidate.text === label);
  if (button === undefined) throw new Error(`кнопки «${label}» нет`);
  return button.target;
}

describe("сходка участника", () => {
  it("участник заводит, публикует и правит свою сходку, а другой участник видит её без управления", async () => {
    const { adminId } = await organizerAtStart(wire, direct);
    const creator = await memberAllowedBy(wire, direct, adminId);
    const author = creator.person;
    const title = titleFor("Сходка участника", creator.telegramUserId);

    await author.says("/start");
    await author.says("/meetups");
    await author.presses("Создать сходку");
    await fillsMeetupForm(author, title);

    // Свой черновик участник видит в общем списке «Сходок» с пометкой
    // «скрыта»: Meetups отдаёт его составу (ADR-076, п. 9), а «Скрытых сходок»
    // в «Управлении» у участника нет.
    await author.says("/meetups");
    expect(author.sees()).toContain(`${title} (скрыта)`);
    await author.presses(listedAs(title));
    expect(author.buttons()).toContain("‹ Сходки");
    await author.presses("🛠 Статус");
    await author.presses("Опубликовать");
    await author.presses("Опубликовать и оповестить");

    expect(author.sees()).toContain("Сходка опубликована");
    const meetupId = meetupIdFromStartLink(author.sees());
    expect(await direct.readAsAdmin(adminId, meetupId)).toMatchObject({
      title,
      visible: true,
    });

    await author.presses("‹ Сходка");
    expect(author.sees()).toContain("Ты организатор этой сходки");
    expect(author.sees()).toContain("Ты автор этой сходки");
    const edit = targetOf(author, "🛠 Изменить");
    await author.presses("🛠 Изменить");
    await author.presses("Название");
    await author.says(`${title} обновлена`);

    expect(author.sees()).toContain("Изменение сохранено");
    expect((await direct.readAsAdmin(adminId, meetupId)).title).toBe(
      `${title} обновлена`,
    );

    // Второй участник читает сходку: кнопок управления нет, а организатора
    // и автора карточка называет ником, который Identity отдал по
    // подтверждению Meetups (ADR-076, п. 10).
    const other = await memberAllowedBy(wire, direct, adminId);
    await other.person.says("/start");
    await other.person.opensLink(meetupId);
    const nick = `@${usernameFor(creator.telegramUserId)}`;
    expect(other.person.sees()).toContain(`Организатор: ${nick}`);
    expect(other.person.sees()).toContain(`Автор: ${nick}`);
    expect(other.person.buttons()).not.toContain("🛠 Изменить");
    expect(other.person.buttons()).not.toContain("🛠 Написать подписчикам");

    // Подделанное нажатие кнопки организатора получает отказ до экрана
    // правки, и сходка не меняется.
    await other.person.pressesRaw(edit);
    expect(other.person.sees()).toContain(
      "Это действие доступно организатору сходки.",
    );
    expect((await direct.readAsAdmin(adminId, meetupId)).title).toBe(
      `${title} обновлена`,
    );
  });
});
