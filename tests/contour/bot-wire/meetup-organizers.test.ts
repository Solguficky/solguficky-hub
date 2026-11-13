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

// ADR-076, п. 6–8, и PER-749: организатор назначает участника по нику,
// соорганизатор не снимает автора, последний в составе не выходит. Всё —
// против настоящих Identity и Meetups: ник Identity находит методом
// `FindOrganizerCandidate`, состав держит Meetups. Доставку вести о назначении
// провод не проверяет — Notifications в контуре нет; её текст и кнопки держит
// L0 бота (`notification-message.test.ts`).
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

// Участник заводит и публикует сходку и становится её автором и первым
// организатором; второй участник уже открыл бота, иначе Identity не знает его
// ника.
async function meetupOfMember() {
  const { adminId, person: admin } = await organizerAtStart(wire, direct);
  const creator = await memberAllowedBy(wire, direct, adminId);
  const author = creator.person;
  const title = titleFor("Организаторы", creator.telegramUserId);
  await author.says("/start");
  await author.says("/meetups");
  await author.presses("Создать сходку");
  await fillsMeetupForm(author, title);
  await author.says("/meetups");
  await author.presses(listedAs(title));
  await author.presses("🛠 Статус");
  await author.presses("Опубликовать");
  await author.presses("Опубликовать и оповестить");
  const meetupId = meetupIdFromStartLink(author.sees());

  const second = await memberAllowedBy(wire, direct, adminId);
  await second.person.says("/start");
  return {
    admin,
    author,
    authorNick: `@${usernameFor(creator.telegramUserId)}`,
    member: second.person,
    memberNick: usernameFor(second.telegramUserId),
    meetupId,
  };
}

// Сходка сценария уходит в архив отменой: файлы контура делят одну базу, и
// опубликованная сходка сдвинула бы чужие сценарии со страницы «Сходок».
async function cancels(admin: Person, meetupId: string) {
  await admin.opensLink(meetupId);
  await admin.presses("🛠 Статус");
  await admin.presses("Отменить сходку");
  await admin.presses("✔️ Да, отменить сходку");
}

// Сценарий над сходкой участника; сходка отменяется и при красном сценарии.
async function withMeetup(
  scenario: (
    meetup: Awaited<ReturnType<typeof meetupOfMember>>,
  ) => Promise<void>,
) {
  const meetup = await meetupOfMember();
  try {
    await scenario(meetup);
  } finally {
    await cancels(meetup.admin, meetup.meetupId);
  }
}

async function appoints(organizer: Person, meetupId: string, nick: string) {
  await organizer.opensLink(meetupId);
  await organizer.presses("🛠 Организаторы");
  await organizer.presses("Добавить");
  await organizer.says(`@${nick}`);
  await organizer.presses("✔️ Да, назначить");
}

describe("meetup organizers over the wire", () => {
  it("appoints a member by username, who then sees the management buttons", async () => {
    await withMeetup(async ({ author, member, memberNick, meetupId }) => {
      await member.opensLink(meetupId);
      expect(member.buttons()).not.toContain("🛠 Изменить");

      await author.opensLink(meetupId);
      await author.presses("🛠 Организаторы");
      await author.presses("Добавить");
      await author.says(`@${memberNick}`);
      expect(author.sees()).toContain("Назначить организатором?");
      await author.presses("✔️ Да, назначить");
      expect(author.sees()).toContain("Организатор назначен");

      await member.opensLink(meetupId);
      expect(member.buttons()).toContain("🛠 Изменить");
      expect(member.buttons()).toContain("🛠 Организаторы");
    });
  });

  it("refuses an unknown username with its own frame and keeps the roster", async () => {
    await withMeetup(async ({ author, member, meetupId }) => {
      await author.opensLink(meetupId);
      await author.presses("🛠 Организаторы");
      await author.presses("Добавить");
      await author.says("@no_such_member_nick");
      expect(author.sees()).toContain("Ник не найден");

      await member.opensLink(meetupId);
      expect(member.buttons()).not.toContain("🛠 Изменить");
    });
  });

  it("refuses a co-organizer dismissing the author by a forged press", async () => {
    await withMeetup(
      async ({ admin, author, authorNick, member, memberNick, meetupId }) => {
        await appoints(author, meetupId, memberNick);

        await member.opensLink(meetupId);
        await member.presses("🛠 Организаторы");
        expect(member.sees()).toContain(`${authorNick} · автор`);
        expect(member.buttons()).not.toContain(`Снять ${authorNick}`);

        await admin.opensLink(meetupId);
        await admin.presses("🛠 Организаторы");
        await member.pressesRaw(targetOf(admin, `Снять ${authorNick}`));
        expect(member.sees()).toContain("Автора снимает только администратор.");
      },
    );
  });

  it("refuses the last organizer leaving the roster", async () => {
    await withMeetup(async ({ author, member, memberNick, meetupId }) => {
      await appoints(author, meetupId, memberNick);

      await member.opensLink(meetupId);
      await member.presses("🛠 Организаторы");
      await member.presses("Выйти");
      await member.presses("✔️ Да, выйти");
      expect(member.sees()).toContain("Ты вышел из организаторов");

      await author.opensLink(meetupId);
      await author.presses("🛠 Организаторы");
      await author.presses("Выйти");
      await author.presses("✔️ Да, выйти");
      expect(author.sees()).toContain("Ты последний в составе.");
    });
  });
});
