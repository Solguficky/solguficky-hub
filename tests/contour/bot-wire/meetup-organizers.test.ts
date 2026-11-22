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

// ADR-076, п. 6–8, PER-749 и PER-879 (дополнение 2026-11-13 к п. 6):
// организатор назначает участника по нику, снимает только администратор,
// последний в составе не выходит. Всё — против настоящих Identity и Meetups:
// ник Identity находит методом `FindOrganizerCandidate`, состав держит
// Meetups. Доставку вестей о назначении и снятии провод не проверяет —
// Notifications в контуре нет; их текст и кнопки держит L0 бота
// (`notification-message.test.ts`), а снявшего в журнале — L1 Meetups.
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
  await author.presses("✨ Создать");
  await fillsMeetupForm(author, title);
  await author.says("/meetups");
  await author.presses(listedAs(title));
  await author.presses("🛠 Управление");
  await author.presses("Публикация");
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
  await admin.presses("🛠 Управление");
  await admin.presses("Завершить или отменить");
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
  await organizer.presses("🛠 Управление");
  await organizer.presses("Организаторы");
  await organizer.presses("Добавить");
  await organizer.says(`@${nick}`);
  await organizer.presses("✔️ Да, назначить");
}

// Экран состава — ряд «Управления» (PER-910): с карточки он больше не
// открывается, и сценарий идёт через единственный вход управления.
async function roster(person: Person, meetupId: string) {
  await person.opensLink(meetupId);
  await person.presses("🛠 Управление");
  await person.presses("Организаторы");
}

describe("meetup organizers over the wire", () => {
  it("appoints a member by username, who then sees the management buttons", async () => {
    await withMeetup(async ({ author, member, memberNick, meetupId }) => {
      await member.opensLink(meetupId);
      expect(member.buttons()).not.toContain("🛠 Управление");

      await roster(author, meetupId);
      await author.presses("Добавить");
      await author.says(`@${memberNick}`);
      expect(author.sees()).toContain("Назначить организатором?");
      await author.presses("✔️ Да, назначить");
      expect(author.sees()).toContain("Организатор назначен");

      await member.opensLink(meetupId);
      expect(member.buttons()).toContain("🛠 Управление");
    });
  });

  it("refuses an unknown username with its own frame and keeps the roster", async () => {
    await withMeetup(async ({ author, member, meetupId }) => {
      await roster(author, meetupId);
      await author.presses("Добавить");
      await author.says("@no_such_member_nick");
      expect(author.sees()).toContain("Ник не найден");

      await member.opensLink(meetupId);
      expect(member.buttons()).not.toContain("🛠 Управление");
    });
  });

  it("hides dismissing from organizers", async () => {
    await withMeetup(
      async ({ author, authorNick, member, memberNick, meetupId }) => {
        await appoints(author, meetupId, memberNick);

        await roster(author, meetupId);
        expect(author.buttons()).not.toContain(`Снять @${memberNick}`);
        await roster(member, meetupId);
        expect(member.sees()).toContain(`${authorNick} · автор`);
        expect(member.buttons()).not.toContain(`Снять ${authorNick}`);
      },
    );
  });

  it("refuses organizers' forged dismissals and keeps the roster", async () => {
    await withMeetup(
      async ({ admin, author, authorNick, member, memberNick, meetupId }) => {
        await appoints(author, meetupId, memberNick);

        await roster(admin, meetupId);
        await member.pressesRaw(targetOf(admin, `Снять ${authorNick}`));
        expect(member.sees()).toContain(
          "Снимать организаторов может только администратор.",
        );
        await author.pressesRaw(targetOf(admin, `Снять @${memberNick}`));
        expect(author.sees()).toContain(
          "Снимать организаторов может только администратор.",
        );

        await member.opensLink(meetupId);
        expect(member.buttons()).toContain("🛠 Управление");
      },
    );
  });

  it("lets the administrator dismiss the author", async () => {
    await withMeetup(
      async ({ admin, author, authorNick, member, memberNick, meetupId }) => {
        await appoints(author, meetupId, memberNick);

        await roster(admin, meetupId);
        await admin.presses(`Снять ${authorNick}`);
        expect(admin.sees()).toContain("Снять организатора?");
        await admin.presses("✔️ Да, снять");
        expect(admin.sees()).toContain("Организатор снят");

        await author.opensLink(meetupId);
        expect(author.buttons()).not.toContain("🛠 Управление");
        await member.opensLink(meetupId);
        expect(member.buttons()).toContain("🛠 Управление");
      },
    );
  });

  it("refuses the last organizer leaving the roster", async () => {
    await withMeetup(async ({ author, member, memberNick, meetupId }) => {
      await appoints(author, meetupId, memberNick);

      await roster(member, meetupId);
      await member.presses("Выйти");
      await member.presses("✔️ Да, выйти");
      expect(member.sees()).toContain("Ты вышел из организаторов");

      await roster(author, meetupId);
      await author.presses("Выйти");
      await author.presses("✔️ Да, выйти");
      expect(author.sees()).toContain("Ты последний в составе.");
    });
  });
});
