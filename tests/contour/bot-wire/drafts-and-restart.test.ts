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
} from "../../../apps/telegram-bot/testkit/index.js";
import { organizerAtStart } from "./steps.js";

// Висящие вопросы формы — угловые случаи 7 и 8. Черновик живёт в Meetups, а
// привязка вопроса к черновику — в памяти процесса бота (ADR-030), поэтому
// рестарт здесь — новый процесс бота над той же базой и той же историей чата.
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

const organizer = () => organizerAtStart(wire, direct);

describe("висящие вопросы формы", () => {
  it("случай 7: ответ на вопрос первого из двух черновиков попадает в первый", async () => {
    const { adminId, person } = await organizer();
    await person.presses("Управление сходками");
    await person.presses("Создать сходку");
    // Первый черновик запоминается до второго: ключи двух меню могут попасть в
    // одну миллисекунду, и порядок UUIDv7 их тогда не различит.
    const [first] = (await direct.journalOf(adminId)).meetupIds;
    await person.presses("Управление сходками");
    await person.presses("Создать сходку");

    await person.answers(1, "Первый черновик");

    const second = (await direct.journalOf(adminId)).meetupIds.find(
      (id) => id !== first,
    );
    if (first === undefined || second === undefined) {
      throw new Error("черновиков меньше двух");
    }
    expect((await direct.readAsAdmin(adminId, first)).title).toBe(
      "Первый черновик",
    );
    expect((await direct.readAsAdmin(adminId, second)).title).toBe("");
  });

  it("случай 8: ответ на вопрос формы создания после рестарта получает понятный текст", async () => {
    const { adminId, person } = await organizer();
    await person.presses("Управление сходками");
    await person.presses("Создать сходку");

    wire.restart();
    await person.says("Название после рестарта");

    expect(person.sees()).toBe(
      "Этот вопрос уже устарел. Открой актуальное меню и повтори действие.",
    );
    const [draftId] = (await direct.journalOf(adminId)).meetupIds;
    if (draftId === undefined) throw new Error("черновик не заведён");
    expect((await direct.readAsAdmin(adminId, draftId)).title).toBe("");
  });

  it("случай 8: ответ на вопрос точечной правки после рестарта восстанавливает шаг из сообщения", async () => {
    const { adminId, person } = await organizer();
    const meetupId = unusedMeetupId();
    await direct.createDraftAsAdmin(adminId, meetupId);
    await person.opensLink(meetupId);
    await person.presses("Изменить");
    await person.presses("Место");

    wire.restart();
    await person.says("Новый зал");

    expect(person.sees()).not.toContain("устарел");
    expect((await direct.readAsAdmin(adminId, meetupId)).venue).toBe(
      "Новый зал",
    );
  });
});
