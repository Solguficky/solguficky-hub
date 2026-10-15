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

/** Дата и время в поясе сообщества, как их пишет администратор в пульте. */
function communityStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((found) => found.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} 00:00`;
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

/** Строка лота в ленте: подпись — название, затем цена. */
function lotRow(person: Person, title: string): string | undefined {
  return person.pressable().find((label) => label.startsWith(`${title} · `));
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
    // право `manage_meetups`, которое уходит в Auction в смотрящем.
    const { adminId, person: admin } = await organizerAtStart(hub, direct);
    const title = titleFor("Аукцион", freshTelegramUserId());
    // Название лота своё на прогон: гость находит лот по нему, а не по цене,
    // которая в ленте может отставать от ставки.
    const lotTitle = titleFor("Кружка", freshTelegramUserId());
    await admin.says("/manage");
    await admin.presses("Сходки и объявления");
    await admin.presses("Создать сходку");
    await fillsMeetupForm(admin, title);
    await admin.presses("Опубликовать");
    await admin.presses("✔️ Да, опубликовать сходку");
    // Сходку открывают по ссылке для чата: список «Сходки» листается, а база
    // контура в режиме `just contour-up` живёт дольше прогона.
    const meetupId = meetupIdFromStartLink(admin.sees());
    // Аукцион — расширение сходки (PER-605): включение и вход — в меню
    // «Расширения» её карточки.
    await admin.presses("‹ Сходка");
    await admin.presses("🧩 Расширения");
    // Первый вызов холодного Auction дольше бюджета действия: меню называет
    // сбой с «Повторить», а не прячет аукцион.
    await eventually(admin, "Включить аукцион", () =>
      admin.presses("Повторить"),
    );
    await admin.presses("Включить аукцион");
    // Повтор включения отвечает тем же аукционом: ключ выводит Auction.
    // Вход в раздел аукциона несёт его знак (PER-644).
    await eventually(admin, "🔨 Аукцион", () => admin.presses("Повторить"));
    await admin.presses("🔨 Аукцион");
    // Чтения Auction отстают от команды: корень покажет «Лоты», когда read
    // model узнает аукцион сходки.
    await eventually(admin, "🔨 Лоты", async () => {
      await admin.opensLink(meetupId);
      await admin.presses("🧩 Расширения");
      if (pressableLike(admin, "🔨 Аукцион") !== undefined) {
        await admin.presses("🔨 Аукцион");
      }
    });
    await admin.presses("🔨 Лоты");
    await admin.presses("Добавить лот");
    await admin.says("Кружка");
    // Цепочка нового лота (PER-618): после названия — цена, способ шага, шаг
    // и фото по порядку. Чтение лота под ценой ждёт отстающую read model.
    await admin.says("1 000");
    await admin.presses("Один шаг");
    await admin.says("100");
    await admin.presses("Пропустить");
    expect(plain(admin.sees())).toContain("Лот готов");
    await admin.presses("Изменить лот");
    // Лот, который форма только что завела, чтения ещё могут не знать: кадр
    // «Лот не найден» несёт «Повторить».
    await eventually(admin, "Название", () => admin.presses("Повторить"));
    await admin.presses("Название");
    await admin.says(lotTitle);
    expect(plain(admin.sees())).toContain(lotTitle);
    await admin.presses("‹ Лот");
    expect(plain(admin.sees())).toContain(lotTitle);

    // Онлайн-неделя идёт с начала сегодняшнего дня по послезавтра.
    const day = 24 * 60 * 60 * 1000;
    const from = communityStamp(new Date());
    const to = communityStamp(new Date(Date.now() + 2 * day));
    await admin.presses("‹ Лоты");
    await admin.presses("‹ Аукцион");
    await admin.presses("Пульт");
    await admin.presses("Сроки недели");
    await admin.says(`${from} — ${to}`);
    await admin.presses("‹ Пульт");
    await eventually(admin, "Открыть онлайн-неделю", () =>
      admin.presses("‹ Пульт"),
    );
    await admin.presses("Открыть онлайн-неделю");
    await eventually(admin, "✔️ Да, открыть неделю", async () => {
      await admin.presses("‹ Пульт");
      await admin.presses("Открыть онлайн-неделю");
    });
    await admin.presses("✔️ Да, открыть неделю");

    // Участник ставит и включает автоставку в боте хаба: его права — хаб и
    // аукцион по кругу.
    const { person: member } = await memberAllowedBy(hub, direct, adminId);
    await member.says("/start");
    await member.opensLink(meetupId);
    await member.presses("🧩 Расширения");
    await eventually(member, "🔨 Аукцион", () => member.presses("Повторить"));
    await member.presses("🔨 Аукцион");
    await member.presses("🔨 Лоты");
    // Строка ленты несёт цену, а не «старт»: лот ищется по названию, как у
    // гостя ниже.
    await member.presses(lotRow(member, lotTitle) ?? lotTitle);
    // Аукцион открывает лоты реестра сам, вслед за командой открытия недели.
    await eventually(member, "По шагу (1 100 ₽)", () =>
      member.presses("Обновить"),
    );
    // Первая ставка: имя спрашивается до подтверждения, и подтверждение одно
    // (PER-595).
    await pressesAmount(member, "По шагу (1 100 ₽)");
    await member.presses("Взять псевдоним");
    await member.says("Сова");
    await pressesAmount(member, "✔️ Да, поставить 1 100 ₽");
    expect(plain(member.sees())).toContain("Ставка 1 100 ₽ принята");
    expect(pressableLike(member, "✔️ Да, поставить")).toBeUndefined();
    expect(pressableLike(member, "‹ Лоты")).toBeDefined();
    // «‹ Лот» дочитывает лот до версии из ответа ставки (PER-470): новая
    // цена и лидер — сразу, без «Обновить».
    await member.presses("‹ Лот");
    expect(plain(member.sees())).toContain("Цена: 1 100 ₽");
    expect(plain(member.sees())).toContain("Лидер: ты (Сова*)");
    expect(plain(member.sees())).toContain("Следующая ставка: от 1 200 ₽");
    await member.presses("Автоставка");
    await member.says("3 000");
    await member.presses("✔️ Да, включить автоставку");
    expect(plain(member.sees())).toContain("3 000 ₽");
    await member.presses("‹ Лот");
    expect(plain(member.sees())).toContain("Твоя автоставка: до 3 000 ₽");
    // После первой ставки «Имя в аукционе» в «Настройках» только называет имя
    // (PER-595): Auction его закрепил.
    await member.says("/settings");
    await member.presses("🧩 Расширения");
    await member.presses("Имя в аукционе");
    expect(plain(member.sees())).toContain("Твоё имя: Сова*");
    expect(pressableLike(member, "Взять псевдоним")).toBeUndefined();

    // Гость подаёт заявку в боте аукциона, администратор допускает его в
    // хабе, и гость торгует с одним правом аукциона.
    const guestId = freshTelegramUserId();
    const guestUsername = usernameFor(guestId);
    const guest = startConversation(auction.bot, auction.calls, guestId, {
      username: guestUsername,
    });
    // `/start` заявку не ставит: её ставит «Подать заявку» под приветствием
    // (дополнение ADR-060 от 2026-10-12).
    await guest.says("/start");
    expect(plain(guest.sees())).toContain("Доступ выдаёт администратор");
    await guest.presses("Подать заявку");
    await admin.says("/manage");
    await admin.presses("Заявки и отказы");
    // Заявка гостя лежит в очереди аукциона, отдельной от очереди сообщества
    // (дополнение ADR-064 к пункту 12).
    await admin.presses("Заявки в аукцион");
    // Очередь отдаётся от старой заявки к новой, а карточка показывает одну:
    // заявки прошлых прогонов администратор пропускает.
    for (let skipped = 0; skipped < 20; skipped += 1) {
      if (plain(admin.sees()).includes(guestUsername)) break;
      await admin.presses("Пропустить");
    }
    expect(plain(admin.sees())).toContain(guestUsername);
    await admin.presses("✔️ Допустить");
    // Первый допущенный `/start` открывает FAQ, а его кнопка «Аукционы»
    // ставит отметку и открывает список.
    await guest.says("/start");
    await guest.presses("Аукционы");
    // Аукцион в боте аукциона адресуется только строкой списка, а строки
    // аукционов с одной датой неотличимы. Поэтому сценарий требует свежей
    // базы — рецепт поднимает её на каждый прогон, — и на базе, где остались
    // аукционы прошлых прогонов (`just contour-up`), отказывает с причиной.
    const rows = guest
      .pressable()
      .filter((label) => label.includes("идут ставки"));
    expect(rows, "сценарию нужна свежая база контура").toHaveLength(1);
    await guest.presses(rows[0] ?? "");
    // Строка списка открывает корень аукциона, как в хабе (PER-644).
    await guest.presses("🔨 Лоты");
    // Цена в ленте может отставать от ставки участника: лот ищется по
    // названию, а цену показывает карточка.
    await guest.presses(lotRow(guest, lotTitle) ?? lotTitle);
    await eventually(guest, "По шагу (1 200 ₽)", () =>
      guest.presses("Обновить"),
    );
    await pressesAmount(guest, "По шагу (1 200 ₽)");
    await guest.presses("Взять псевдоним");
    await guest.says("Филин");
    await pressesAmount(guest, "✔️ Да, поставить 1 200 ₽");
    expect(plain(guest.sees())).toContain("Ставка 1 200 ₽ принята");
    // Автоставка участника отвечает гостю в той же транзакции, и «‹ Лот»
    // сразу показывает цену на шаг выше — версия ответа её уже несёт.
    await guest.presses("‹ Лот");
    expect(plain(guest.sees())).toContain("Цена: 1 300 ₽");
    expect(pressableLike(guest, "По шагу (1 400 ₽)")).toBeDefined();
    await guest.presses("Автоставка");
    await guest.says("5 000");
    await guest.presses("✔️ Да, включить автоставку");
    expect(plain(guest.sees())).toContain("5 000 ₽");
    // Лимит гостя перебивает лимит участника той же командой.
    await guest.presses("‹ Лот");
    expect(plain(guest.sees())).toContain("Твоя автоставка: до 5 000 ₽");
    expect(plain(guest.sees())).toContain("Лидер: ты (Филин*)");

    // Гость без права аукциона видит приветствие без заявки; «Подать заявку»
    // ставит её, и бот отвечает ожиданием — ни меню, ни лота ему не открыто.
    const pendingId = freshTelegramUserId();
    const pending = startConversation(auction.bot, auction.calls, pendingId, {
      username: usernameFor(pendingId),
    });
    await pending.says("/start");
    expect(pending.pressable()).toEqual(["Подать заявку"]);
    await pending.presses("Подать заявку");
    expect(plain(pending.sees())).toContain("Заявка на рассмотрении");
    expect(pending.pressable()).not.toContain("Аукционы");
  });
});
