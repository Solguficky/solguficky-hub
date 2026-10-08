import {
  afterAll,
  auctionBotInfo,
  beforeAll,
  describe,
  expect,
  freshTelegramUserId,
  it,
  meetupIdFromStartLink,
  openAuctionBotWire,
  openBotWire,
  openDirectClients,
  type Person,
  readAuctionContourEnvironment,
  readContourEnvironment,
  startConversation,
  usernameFor,
} from "../../../../apps/hub-bot/testkit/index.js";
import {
  fillsMeetupForm,
  memberAllowedBy,
  organizerAtStart,
  titleFor,
} from "../steps.js";

// Торги через оба бота против настоящего Auction (PER-543). Auction решает по
// правам смотрящего и ролей не читает (ADR-064, пункт 6): бот, который
// потерял права по дороге, получил бы отказ на любом шаге ниже.

const environment = readContourEnvironment();
const auctionEnvironment = readAuctionContourEnvironment();
const direct = openDirectClients(environment);
// Хаб даёт гостю ссылку на бот аукциона — тот, с которым говорит провод ниже.
const hub = openBotWire({
  ...environment,
  auctionUrl: auctionEnvironment.auctionUrl,
  auctionBotUsername: auctionBotInfo.username,
});
const auction = openAuctionBotWire(auctionEnvironment);

beforeAll(async () => {
  await direct.waitUntilReachable();
});

afterAll(() => {
  hub.close();
  auction.close();
  direct.close();
});

const LOT_TITLE = "Кружка солегуфика";

/** Дата и время в поясе сообщества, как их пишет администратор в пульте. */
function communityStamp(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts["day"]}.${parts["month"]}.${parts["year"]} 00:00`;
}

// Подписи сравниваются без различия пробелов: суммы бот разделяет
// неразрывным пробелом, а сценарий пишет обычный — как пульт провода.
const plain = (text: string) => text.replace(/\s/g, " ");

function pressableLike(person: Person, label: string): string | undefined {
  return person.pressable().find((text) => plain(text) === label);
}

async function pressesAmount(person: Person, label: string): Promise<void> {
  await person.presses(pressableLike(person, label) ?? label);
}

/**
 * Повторяет шаг, пока у человека не появится кнопка: read model Auction
 * догоняет команду за доли секунды, а сценарий быстрее человека.
 */
async function eventually(
  person: Person,
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (pressableLike(person, label) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await step();
  }
  expect(person.pressable().map(plain)).toContain(label);
}

describe("auction through both bots", () => {
  it("lets the admin, a member and an admitted guest act with their rights and refuses a guest without the auction right", async () => {
    // Администратор заводит сходку с аукционом и лот: каталог лотов открывает
    // право `manage_auction`, которое уходит в Auction в смотрящем.
    const { adminId, person: admin } = await organizerAtStart(hub, direct);
    const title = titleFor("Аукцион", freshTelegramUserId());
    await admin.presses("Управление");
    await admin.presses("Создать сходку");
    await fillsMeetupForm(admin, title);
    await admin.presses("Опубликовать");
    // Сходку открывают по ссылке для чата: список Ближайших листается, а база
    // контура в режиме `just contour-up` живёт дольше прогона.
    const meetupId = meetupIdFromStartLink(admin.sees());
    await admin.presses("‹ Сходка");
    await admin.presses("Включить аукцион");
    await admin.presses("‹ Сходка");
    // Чтения Auction отстают от команды: карточка покажет «Лоты», когда read
    // model узнает аукцион сходки.
    await eventually(admin, "Лоты", () => admin.opensLink(meetupId));
    await admin.presses("Лоты");
    await admin.presses("Добавить лот");
    await admin.says("Кружка");
    await admin.presses("Изменить лот");
    // Лот, который форма только что завела, чтения ещё могут не знать: кадр
    // «Лот не найден» несёт «Повторить».
    await eventually(admin, "Название", () => admin.presses("Повторить"));
    await admin.presses("Название");
    await admin.says(LOT_TITLE);
    expect(plain(admin.sees())).toContain(LOT_TITLE);
    await admin.presses("Изменить лот");
    await eventually(admin, "Цена и шаг", () => admin.presses("Повторить"));
    await admin.presses("Цена и шаг");
    await admin.says("1 000");
    await admin.says("100");
    expect(plain(admin.sees())).toContain("Цена и шаг сохранены");
    await admin.presses("‹ Лот");
    expect(plain(admin.sees())).toContain(LOT_TITLE);

    // Онлайн-неделя идёт с начала сегодняшнего дня по послезавтра.
    const day = 24 * 60 * 60 * 1000;
    const from = communityStamp(new Date());
    const to = communityStamp(new Date(Date.now() + 2 * day));
    await admin.presses("‹ Лоты");
    await admin.presses("Пульт");
    await admin.presses("Сроки недели");
    await admin.says(`${from} — ${to}`);
    await admin.presses("‹ Пульт");
    await eventually(admin, "Открыть онлайн-неделю", () =>
      admin.presses("‹ Пульт"),
    );
    await admin.presses("Открыть онлайн-неделю");
    await eventually(admin, "Да, открыть неделю", async () => {
      await admin.presses("‹ Пульт");
      await admin.presses("Открыть онлайн-неделю");
    });
    await admin.presses("Да, открыть неделю");

    // Участник ставит и включает автоставку в боте хаба: его права — хаб и
    // аукцион по кругу.
    const { person: member } = await memberAllowedBy(hub, direct, adminId);
    await member.says("/start");
    await member.opensLink(meetupId);
    await member.presses("Лоты");
    await pressesAmount(member, `${LOT_TITLE} · старт 1 000 ₽`);
    // Аукцион открывает лоты реестра сам, вслед за командой открытия недели.
    await eventually(member, "По шагу (1 100 ₽)", () =>
      member.presses("Обновить"),
    );
    await pressesAmount(member, "По шагу (1 100 ₽)");
    await pressesAmount(member, "Да, поставить 1 100 ₽");
    await member.presses("Взять псевдоним");
    await member.says("Сова");
    await pressesAmount(member, "Да, поставить 1 100 ₽");
    expect(plain(member.sees())).toContain("1 100 ₽");
    await member.presses("К лоту");
    await eventually(member, "Автоставка", () => member.presses("Обновить"));
    await member.presses("Автоставка");
    await member.says("3 000");
    await member.presses("Да, включить автоставку");
    expect(plain(member.sees())).toContain("3 000 ₽");

    // Гость подаёт заявку в боте аукциона, администратор допускает его в
    // хабе, и гость торгует с одним правом аукциона.
    const guestId = freshTelegramUserId();
    const guestUsername = usernameFor(guestId);
    const guest = startConversation(auction.bot, auction.calls, guestId, {
      username: guestUsername,
    });
    await guest.says("/start");
    await admin.says("/menu");
    await admin.presses("Управление");
    await admin.presses("Заявки");
    expect(plain(admin.sees())).toContain(guestUsername);
    await admin.presses("Допустить");
    await guest.says("/start");
    await guest.presses("‹ Меню");
    await guest.presses("Аукционы");
    // Активный аукцион один — сходки этого прогона; строка называет его дату.
    const row = guest
      .pressable()
      .find((label) => label.includes("идут ставки"));
    expect(row).toBeDefined();
    await guest.presses(row ?? "");
    await pressesAmount(guest, `${LOT_TITLE} · 1 100 ₽`);
    await pressesAmount(guest, "По шагу (1 200 ₽)");
    await pressesAmount(guest, "Да, поставить 1 200 ₽");
    await guest.presses("Взять псевдоним");
    await guest.says("Филин");
    await pressesAmount(guest, "Да, поставить 1 200 ₽");
    expect(plain(guest.sees())).toContain("Ставка 1 200 ₽ принята");
    // Автоставка участника отвечает гостю: на карточке цена уже на шаг выше.
    await guest.presses("К лоту");
    await eventually(guest, "По шагу (1 400 ₽)", () =>
      guest.presses("Обновить"),
    );
    expect(plain(guest.sees())).toContain("1 300 ₽");
    await guest.presses("Автоставка");
    await guest.says("5 000");
    await guest.presses("Да, включить автоставку");
    expect(plain(guest.sees())).toContain("5 000 ₽");

    // Гость без права аукциона — заявка ещё на рассмотрении — до Auction не
    // доходит: вход отвечает ожиданием, и ни меню, ни лота ему не открыто.
    const pendingId = freshTelegramUserId();
    const pending = startConversation(auction.bot, auction.calls, pendingId, {
      username: usernameFor(pendingId),
    });
    await pending.says("/start");
    expect(plain(pending.sees())).toContain("Заявка на рассмотрении");
    expect(pending.pressable()).not.toContain("Аукционы");
  });
});
