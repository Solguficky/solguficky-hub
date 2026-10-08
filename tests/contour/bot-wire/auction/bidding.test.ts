import {
  afterAll,
  auctionBotInfo,
  beforeAll,
  describe,
  expect,
  freshTelegramUserId,
  it,
  openAuctionBotWire,
  openBotWire,
  openDirectClients,
  readAuctionContourEnvironment,
  readContourEnvironment,
  startConversation,
  usernameFor,
} from "../../../../apps/hub-bot/testkit/index.js";
import {
  fillsMeetupForm,
  listedAs,
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
    await admin.presses("‹ Сходка");
    await admin.presses("Включить аукцион");
    await admin.presses("Лоты");
    await admin.presses("Добавить лот");
    await admin.says("Кружка");
    await admin.presses("Название");
    await admin.says(LOT_TITLE);
    expect(admin.sees()).toContain(LOT_TITLE);
    await admin.presses("Цена и шаг");
    await admin.says("1 000");
    await admin.says("100");
    await admin.presses("‹ Лот");
    expect(admin.sees()).toContain(LOT_TITLE);

    // Онлайн-неделя идёт с начала сегодняшнего дня по послезавтра.
    const day = 24 * 60 * 60 * 1000;
    const from = communityStamp(new Date());
    const to = communityStamp(new Date(Date.now() + 2 * day));
    await admin.presses("‹ Лоты");
    await admin.presses("Пульт");
    await admin.presses("Сроки недели");
    await admin.says(`${from} — ${to}`);
    await admin.presses("Открыть онлайн-неделю");
    await admin.presses("Да, открыть неделю");

    // Участник ставит и включает автоставку в боте хаба: его права — хаб и
    // аукцион по кругу.
    const { person: member } = await memberAllowedBy(hub, direct, adminId);
    await member.says("/start");
    await member.presses("Ближайшие сходки");
    await member.presses(listedAs(title));
    await member.presses("Лоты");
    await member.presses(`${LOT_TITLE} · 1 000 ₽`);
    await member.presses("По шагу (1 100 ₽)");
    await member.presses("Да, поставить 1 100 ₽");
    await member.presses("Взять псевдоним");
    await member.says("Сова");
    await member.presses("Да, поставить 1 100 ₽");
    expect(member.sees()).toContain("1 100 ₽");
    await member.presses("Автоставка");
    await member.says("3 000");
    await member.presses("Да, включить автоставку");
    expect(member.sees()).toContain("3 000 ₽");

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
    expect(admin.sees()).toContain(guestUsername);
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
    await guest.presses(`${LOT_TITLE} · 1 100 ₽`);
    await guest.presses("По шагу (1 200 ₽)");
    await guest.presses("Да, поставить 1 200 ₽");
    await guest.presses("Взять псевдоним");
    await guest.says("Филин");
    await guest.presses("Да, поставить 1 200 ₽");
    // Автоставка участника ответила гостю: его ставка уже перебита.
    expect(guest.sees()).toContain("1 300 ₽");
    await guest.presses("Автоставка");
    await guest.says("5 000");
    await guest.presses("Да, включить автоставку");
    expect(guest.sees()).toContain("5 000 ₽");

    // Гость без права аукциона — заявка ещё на рассмотрении — до Auction не
    // доходит: вход отвечает ожиданием, и ни меню, ни лота ему не открыто.
    const pendingId = freshTelegramUserId();
    const pending = startConversation(auction.bot, auction.calls, pendingId, {
      username: usernameFor(pendingId),
    });
    await pending.says("/start");
    expect(pending.sees()).toContain("Заявка на рассмотрении");
    expect(pending.pressable()).not.toContain("Аукционы");
  });
});
