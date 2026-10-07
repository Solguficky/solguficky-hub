import {
  encodeAuctionCallback,
  type LotView,
  type Money,
} from "@solguficky/auction-bot-ui";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createHarness, type RecordedCall } from "../../testkit/harness.js";
import { createDispatcher } from "../application/dispatcher.js";
import type {
  AddLotResult,
  AuctionScreens,
  LotAdministration,
  MeetupAuctions,
  ScheduleLotResult,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import { uuidToToken } from "./meetup-deep-link.js";
import { newLotIdOf } from "./new-lot-id.js";
import type { FileDownload, TelegramFiles } from "./telegram-files.js";

// Форма лота администратора в боте хаба (PER-319): входы в ленте и под
// карточкой лота, вопросы и экран правки. Auction подменён одним состоянием на
// команды и чтения: лот, заведённый формой, читают те же порты, что рисуют
// ленту. Бот между шагами пересоздаётся там, где проверяется рестарт.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const auctionToken = uuidToToken(auctionId);
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const existingLot = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";

const feedData = encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });
const lotData = (lotId: string) =>
  encodeAuctionCallback({ kind: "lot", lotId, page: 0 });

const rub = (minorUnits: number): Money => ({ minorUnits, currency: "RUB" });

function identity(globalRoles: readonly string[]) {
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      globalRoles,
      blocked: false,
    }),
  } satisfies IdentityResolver;
}

// Auction формы: карточки, реестр и условия в одном состоянии. Команда,
// которой тест задал отказ, состояние не меняет.
function fakeAuction(
  options: {
    lots?: readonly LotView[];
    // Отказ команды; `undefined` — команда принята.
    add?: () => AddLotResult | undefined;
    schedule?: () => ScheduleLotResult | undefined;
    // Предел изображения Auction в байтах; по умолчанию — 1 МиБ, как у него.
    imageLimit?: number;
  } = {},
) {
  const imageLimit = options.imageLimit ?? 1024 * 1024;
  // Байты изображений по лоту: их отдаёт `GetLotImage` экрана лота.
  const images = new Map<string, { content: Uint8Array; version: string }>();
  const lots = new Map<string, LotView>(
    (options.lots ?? []).map((lot) => [lot.lotId, lot]),
  );
  const cards = new Map<string, { title: string; description: string }>();
  const commands: { method: string; args: unknown }[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const port: MeetupAuctions & AuctionScreens & LotAdministration = {
    getMeetupAuction: notUsed,
    enableAuction: notUsed,
    async createLotCard(_person, card) {
      commands.push({ method: "createLotCard", args: card });
      cards.set(card.lotId, {
        title: card.title,
        description: card.description,
      });
      return { kind: "ok" };
    },
    async editLotCard(_person, card) {
      commands.push({ method: "editLotCard", args: card });
      const lot = lots.get(card.lotId);
      if (lot === undefined) return { kind: "card-not-found" };
      const image = card.image;
      if (image !== undefined && image.byteLength > imageLimit) {
        return { kind: "image-too-large", maxBytes: imageLimit };
      }
      if (image !== undefined) {
        images.set(card.lotId, {
          content: image,
          version: `img-${images.size + 1}`,
        });
      }
      const stored = images.get(card.lotId);
      lots.set(card.lotId, {
        ...lot,
        card: {
          title: card.title,
          description: card.description,
          ...(stored === undefined
            ? {}
            : { image: { version: stored.version } }),
        },
      });
      return { kind: "ok" };
    },
    async addLot(_person, added) {
      commands.push({ method: "addLot", args: added });
      const refused = options.add?.();
      if (refused !== undefined) return refused;
      const card = cards.get(added.lotId);
      lots.set(added.lotId, {
        lotId: added.lotId,
        auctionId: added.auctionId,
        version: 1,
        ...(card === undefined ? {} : { card }),
        proxyEnabled: false,
        status: { kind: "draft" },
      });
      return { kind: "ok" };
    },
    async scheduleLot(_person, terms) {
      commands.push({ method: "scheduleLot", args: terms });
      const refused = options.schedule?.();
      if (refused !== undefined) return refused;
      const lot = lots.get(terms.lotId);
      if (lot === undefined) return { kind: "lot-not-in-auction" };
      lots.set(terms.lotId, {
        ...lot,
        fixedStep: terms.step,
        status: { kind: "scheduled", startingPrice: terms.startingPrice },
      });
      return { kind: "ok" };
    },
    async getLot(_person, lotId) {
      const lot = lots.get(lotId);
      return lot === undefined ? { kind: "not-found" } : { kind: "ok", lot };
    },
    screenPorts() {
      return {
        auction: {
          async getLot({ lotId }) {
            const lot = lots.get(lotId);
            if (lot === undefined) throw new Error("lot not found");
            return lot;
          },
          listAuctionLots: async () => ({
            lots: [...lots.values()],
            nextPageToken: "",
          }),
          listLotHistory: async () => ({ entries: [], nextPageToken: "" }),
          getDisplayNames: async () => ({}),
          placeBid: async () => ({ kind: "accepted" }),
          setProxyLimit: async () => ({ kind: "accepted" }),
          chooseDisplayName: async () => ({ kind: "accepted", name: "@owl" }),
        },
        operations: {
          newOperationId: () => "0198f2a4-7c1e-7d3a-9b21-00000000c001",
        },
        image: {
          async getLotImage({ lotId }) {
            const stored = images.get(lotId);
            if (stored === undefined) throw new Error("no image");
            return { ...stored, mediaType: "image/jpeg" };
          },
        },
      };
    },
  };
  return {
    port,
    lots,
    images,
    commands,
    methods: () => commands.map((command) => command.method),
  };
}

// Новый бот над тем же Auction и той же историей чата: так выглядит рестарт.
function harness(
  roles: readonly string[],
  auction: ReturnType<typeof fakeAuction>,
  calls: RecordedCall[] = [],
  options: {
    presentation?: "rich" | "plain";
    telegram?: ReturnType<typeof fakeTelegramFiles>;
  } = {},
) {
  const telegram = options.telegram ?? fakeTelegramFiles();
  return createHarness(
    identity(roles),
    createDispatcher(
      undefined,
      undefined,
      undefined,
      auction.port,
      auction.port,
    ),
    calls,
    undefined,
    options.presentation ?? "plain",
    undefined,
    {
      auction: auction.port,
      files: telegram.files,
      respond: telegram.respond,
    },
  );
}

// Файлы Telegram: `getFile` отвечает путём по `file_id`, а скачивание по пути
// отдаёт байты. Файл, которого тест не завёл, `getFile` не знает.
function fakeTelegramFiles(
  stored: Record<string, Uint8Array> = {},
  download?: (path: string) => FileDownload,
) {
  const downloads: string[] = [];
  const files: TelegramFiles = {
    async download(path) {
      downloads.push(path);
      if (download !== undefined) return download(path);
      const bytes = stored[path.replace(/^photos\//, "")];
      return bytes === undefined
        ? {
            kind: "failed",
            reason: "unavailable",
            cause: new Error("not found"),
          }
        : { kind: "ok", bytes };
    },
  };
  const respond = (method: string, payload: unknown) => {
    if (method !== "getFile") return undefined;
    const fileId = (payload as { file_id: string }).file_id;
    return fileId in stored
      ? {
          file_id: fileId,
          file_unique_id: `u-${fileId}`,
          file_path: `photos/${fileId}`,
        }
      : {
          ok: false,
          error_code: 400,
          description: "Bad Request: invalid file_id",
        };
  };
  return { files, respond, downloads };
}

function press(data: string): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        text: "Лоты",
      },
    } as never,
  };
}

type Sent = {
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard: { text: string; callback_data?: string }[][];
  };
};

function shown(calls: readonly RecordedCall[]): Sent[] {
  return calls
    .filter((call) => ["editMessageText", "sendMessage"].includes(call.method))
    .map((call) => call.payload as Sent);
}

function last(calls: readonly RecordedCall[]): Sent {
  const screen = shown(calls).at(-1);
  if (screen === undefined) throw new Error("nothing was shown");
  return screen;
}

/** Текст кадра без разметки: кадр отказа выделяет первое предложение. */
function plain(screen: Sent): string {
  return (screen.text ?? "").replaceAll(/<\/?b>/g, "");
}

function labels(screen: Sent): string[][] {
  return (screen.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => button.text),
  );
}

function dataOf(screen: Sent, text: string): string {
  const found = screen.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

// Экран исхода после непринятого ответа: причина в заголовке, «Ввести заново»
// и возврат. Нажатие «Ввести заново» задаёт вопрос снова (PER-472).
async function reasked(
  bot: { handleUpdate: (update: Update) => Promise<void> },
  calls: readonly RecordedCall[],
  reason: string,
) {
  const refusal = last(calls);
  expect(refusal.reply_markup?.force_reply).not.toBe(true);
  // Заголовок экрана исхода — первое предложение причины без точки.
  expect(plain(refusal).split("\n")[0]).toBe(reason.replace(/\.$/, ""));
  await bot.handleUpdate(press(dataOf(refusal, "Ввести заново")));
  return question(calls).payload;
}

// Последний вопрос в чате: его текст, клавиатура и номер сообщения, которым
// ответил бы Telegram, — как их вернёт клиент в `reply_to_message`.
function question(calls: readonly RecordedCall[]) {
  const index = calls.findLastIndex(
    (call) =>
      call.method === "sendMessage" &&
      (call.payload as Sent).reply_markup?.force_reply === true,
  );
  if (index === -1) throw new Error("no question was asked");
  const payload = calls[index]?.payload as Sent;
  return { payload, messageId: 100 + index + 1 };
}

function answer(
  calls: readonly RecordedCall[],
  text: string,
  from = 42,
): Update {
  return reply(calls, { text }, from);
}

// Ответ на последний вопрос с любым содержимым: фото, документ, стикер.
function reply(
  calls: readonly RecordedCall[],
  content: Record<string, unknown>,
  from = 42,
): Update {
  const asked = question(calls);
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: from, is_bot: false, first_name: "tester" },
      ...(content as { text?: string }),
      reply_to_message: {
        message_id: asked.messageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: asked.payload.text,
        reply_markup: asked.payload.reply_markup,
        // grammY's ReplyMessage intersects Message with a required `undefined`
        // property, which is uninhabitable under exactOptionalPropertyTypes.
      } as never,
    },
  };
}

const scheduled: LotView = {
  lotId: existingLot,
  auctionId,
  version: 2,
  card: { title: "Кружка с совой", description: "Ручная роспись." },
  proxyEnabled: false,
  fixedStep: rub(10_000),
  status: { kind: "scheduled", startingPrice: rub(50_000) },
};

describe("entries into the lot form", () => {
  it("shows the administrator how to add a lot in the feed and how to change one under its card", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(feedData));
    const feed = last(calls);
    // Действие экрана стоит первым рядом, над лотами.
    expect(labels(feed)[0]).toEqual(["Добавить лот"]);
    expect(dataOf(feed, "Добавить лот")).toBe(`v1:lot:new:${auctionToken}`);

    await bot.handleUpdate(press(lotData(existingLot)));
    const card = last(calls);
    expect(labels(card)).toContainEqual(["Изменить лот"]);
    expect(dataOf(card, "Изменить лот")).toBe(
      `v1:lot:form:${uuidToToken(existingLot)}`,
    );
  });

  it("shows a member neither entry", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness(["member", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(feedData));
    await bot.handleUpdate(press(lotData(existingLot)));

    const text = JSON.stringify(shown(calls));
    expect(text).not.toContain("Добавить лот");
    expect(text).not.toContain("Изменить лот");
  });

  it("refuses a form button and an answer of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    // Вопрос остался в чате от администратора; роль с тех пор сняли.
    const asked = harness(["admin", "public"], auction);
    await asked.bot.init();
    await asked.bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const member = harness(["member", "public"], auction);
    await member.bot.init();

    for (const data of [
      `v1:lot:new:${auctionToken}`,
      `v1:lot:form:${uuidToToken(existingLot)}`,
      `v1:lot:ask:${uuidToToken(existingLot)}:price`,
    ]) {
      await member.bot.handleUpdate(press(data));
      expect(last(member.calls).text).toContain(
        "Это действие тебе недоступно.",
      );
    }
    await member.bot.handleUpdate(answer(asked.calls, "Ваза"));

    expect(last(member.calls).text).toContain("Это действие тебе недоступно.");
    expect(
      shown(member.calls).some((sent) => sent.reply_markup?.force_reply),
    ).toBe(false);
    expect(auction.commands).toEqual([]);
    expect(member.records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      use_case: "manage_lot",
    });
  });
});

describe("lot form", () => {
  it("asks only the title, adds the lot to the auction and opens its form with the rest left to fill", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const asked = question(calls).payload;
    expect(asked.text).toBe(
      "Как называется лот? Название увидят участники в ленте и на карточке.",
    );
    // Лот получил идентификатор до ответа: шаг целиком лежит в «Отмене».
    const step = dataOf(asked, "Отмена");
    expect(step).toMatch(
      new RegExp(`^v1:q:ln:${auctionToken}:[A-Za-z0-9_-]{12}:42$`),
    );
    const lotId = newLotIdOf(step.split(":")[4] ?? "");

    await bot.handleUpdate(answer(calls, "Ваза синяя"));

    expect(auction.commands).toEqual([
      {
        method: "createLotCard",
        args: { lotId, title: "Ваза синяя", description: "" },
      },
      {
        method: "addLot",
        // Ключ команды — идентификатор лота: один на вопрос о названии.
        args: { auctionId, lotId, opId: lotId },
      },
    ]);
    const form = last(calls);
    // Исход — свой экран: заголовок, название лота в кавычках и остаток.
    expect(form.text).toBe(
      [
        "<b>Лот добавлен</b>",
        "«Ваза синяя»",
        "Задай цену и шаг: без них он не выйдет на торги.",
      ].join("\n\n"),
    );
    expect(labels(form)).toEqual([["Изменить лот"], ["‹ Лот", "Меню"]]);
    expect(dataOf(form, "‹ Лот")).toBe(lotData(lotId));
    // Форма с недостающими полями открывается кнопкой «Изменить лот».
    await bot.handleUpdate(press(dataOf(form, "Изменить лот")));
    const opened = last(calls);
    expect(opened.text).toBe(
      [
        "<b>Изменить лот</b>",
        [
          "Название: Ваза синяя",
          "Описание: нет",
          "Фото: нет",
          "Стартовая цена: не задана",
          "Шаг: не задан",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(labels(opened)).toEqual([
      ["Название"],
      ["Описание"],
      ["Фото"],
      ["Цена и шаг"],
      ["‹ Лот", "Меню"],
    ]);
    // Лот виден в ленте аукциона сходки, пока без цены.
    await bot.handleUpdate(press(feedData));
    expect(JSON.stringify(last(calls))).toContain("Ваза синяя · готовится");
  });

  it("keeps every entered step over a restart of the bot and saves the price with the step as one command", async () => {
    const auction = fakeAuction();
    const calls: RecordedCall[] = [];
    // Каждый шаг ведёт новый бот: память процесса между шагами не доживает.
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness(["admin", "public"], auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(`v1:lot:new:${auctionToken}`));
    const key = dataOf(question(calls).payload, "Отмена").split(":")[4] ?? "";
    await next((history) => answer(history, "Ваза"));
    // Лот создан под идентификатором из ключа в кнопке вопроса.
    const lotId = [...auction.lots.keys()][0] ?? "";
    expect(lotId).toBe(newLotIdOf(key));
    await next(() => press(`v1:lot:ask:${uuidToToken(lotId)}:price`));
    await next((history) => answer(history, "1 500"));

    // Цена ушла в кнопку вопроса о шаге, а не в память и не в Auction.
    const step = question(calls).payload;
    expect(dataOf(step, "Отмена")).toBe(
      `v1:q:ls:${uuidToToken(lotId)}:1500:42`,
    );
    expect(step.text).toContain("Стартовая цена: 1 500 ₽.");
    expect(auction.methods()).toEqual(["createLotCard", "addLot"]);

    await next((history) => answer(history, "100"));

    expect(auction.commands.at(-1)).toEqual({
      method: "scheduleLot",
      args: {
        auctionId,
        lotId,
        opId: expect.any(String),
        startingPrice: rub(150_000),
        step: rub(10_000),
      },
    });
    const form = last(calls);
    expect(form.text).toBe(
      ["<b>Цена и шаг сохранены</b>", "«Ваза»"].join("\n\n"),
    );
    expect(labels(form)).toEqual([["Изменить лот"], ["‹ Лот", "Меню"]]);
    // Значения видны на форме, которую открывает «Изменить лот».
    await next(() => press(dataOf(form, "Изменить лот")));
    expect(last(calls).text).toContain("Стартовая цена: 1 500 ₽");
    expect(last(calls).text).toContain("Шаг: 100 ₽");
    // Заведённый формой лот стоит в ленте аукциона сходки со стартовой ценой.
    await next(() => press(feedData));
    expect(JSON.stringify(last(calls))).toContain("Ваза · старт 1 500 ₽");
  });

  it("ignores an answer to a question of the form from anyone but the asked after a restart", async () => {
    const auction = fakeAuction();
    const calls: RecordedCall[] = [];
    const first = harness(["admin", "public"], auction, calls);
    await first.bot.init();
    await first.bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const shownBefore = shown(calls).length;

    // Новый бот знает спрашиваемого только из кнопки вопроса (PER-461).
    const second = harness(["admin", "public"], auction, calls);
    await second.bot.init();
    await second.bot.handleUpdate(answer(calls, "Чужая ваза", 77));

    expect(auction.methods()).toEqual([]);
    expect(shown(calls)).toHaveLength(shownBefore);

    await second.bot.handleUpdate(answer(calls, "Ваза"));

    expect(auction.methods()).toEqual(["createLotCard", "addLot"]);
  });

  it("answers a price or a step that is not a number with a reason screen and the question again on request, not an exception", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls, records } = harness(["admin", "public"], auction);
    await bot.init();
    const lot = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:price`));
    expect(question(calls).payload.text).toBe(
      [
        "Сейчас: 500 ₽",
        "Стартовая цена в рублях, целым числом. Например: 1500",
      ].join("\n"),
    );
    const refused = question(calls);
    await bot.handleUpdate(answer(calls, "дорого"));

    // Причина — новый экран без вопроса, прежний вопрос закрыт.
    const refusal = last(calls);
    expect(labels(refusal)).toEqual([["Ввести заново"], ["‹ Лот", "Меню"]]);
    expect(
      calls.some(
        (call) =>
          call.method === "editMessageReplyMarkup" &&
          (call.payload as { message_id?: number }).message_id ===
            refused.messageId,
      ),
    ).toBe(true);
    const again = await reasked(bot, calls, "Нужно целое число рублей");
    expect(again.text).toBe(
      [
        "Сейчас: 500 ₽",
        "Стартовая цена в рублях, целым числом. Например: 1500",
      ].join("\n"),
    );
    expect(dataOf(again, "Отмена")).toBe(`v1:q:lp:${lot}:42`);

    await bot.handleUpdate(answer(calls, "700"));
    await bot.handleUpdate(answer(calls, "0"));

    // «Ввести заново» после шага ведёт к вопросу о цене с начала цепочки.
    const step = await reasked(bot, calls, "Сумма — от 1 до 9 999 999 рублей.");
    expect(dataOf(step, "Отмена")).toBe(`v1:q:lp:${lot}:42`);
    expect(auction.commands).toEqual([]);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });

  it("changes one text of the card and shows the outcome with a way back to the form", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ask:${uuidToToken(existingLot)}:description`),
    );
    expect(question(calls).payload.text).toContain("Сейчас: Ручная роспись.");
    await bot.handleUpdate(answer(calls, "Ручная роспись, 300 мл."));

    expect(auction.commands).toEqual([
      {
        method: "editLotCard",
        args: {
          lotId: existingLot,
          title: "Кружка с совой",
          description: "Ручная роспись, 300 мл.",
        },
      },
    ]);
    const saved = last(calls);
    expect(saved.text).toBe(
      ["<b>Изменение сохранено</b>", "«Кружка с совой»"].join("\n\n"),
    );
    expect(labels(saved)).toEqual([["Изменить лот"], ["‹ Лот", "Меню"]]);
    // Новый текст виден на форме, которую открывает «Изменить лот».
    await bot.handleUpdate(press(dataOf(saved, "Изменить лот")));
    expect(last(calls).text).toContain("Описание: Ручная роспись, 300 мл.");
  });

  it("keeps the text and photo rows once trading started and refuses an old price button", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          status: {
            kind: "trading",
            currentPrice: rub(50_000),
            phase: "online",
          },
        },
      ],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    const lot = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:form:${lot}`));
    const form = last(calls);
    // Фото — каталог, а не условия торгов: его ряд остаётся (ADR-057).
    expect(labels(form)).toEqual([
      ["Название"],
      ["Описание"],
      ["Фото"],
      ["‹ Лот", "Меню"],
    ]);
    expect(form.text).toContain(
      "Торги по лоту начались: цену и шаг изменить нельзя.",
    );

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:price`));

    expect(plain(last(calls))).toBe(
      "Торги уже начались. Цену и шаг лота изменить нельзя.",
    );
    expect(question.bind(null, calls)).toThrow("no question was asked");
    expect(auction.commands).toEqual([]);
  });

  it("tells the administrator that trading started when Auction freezes the terms after both answers", async () => {
    const auction = fakeAuction({
      lots: [scheduled],
      schedule: () => ({ kind: "lots-frozen" }),
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ask:${uuidToToken(existingLot)}:price`),
    );
    await bot.handleUpdate(answer(calls, "700"));
    await bot.handleUpdate(answer(calls, "50"));

    const refusal = last(calls);
    expect(plain(refusal)).toBe(
      "Торги уже начались. Цену и шаг лота изменить нельзя.",
    );
    expect(labels(refusal)).toEqual([["‹ Лот", "Меню"]]);
    expect(auction.lots.get(existingLot)?.status).toEqual(scheduled.status);
  });

  it("leaves the question open when Auction does not answer, so the same title can be sent again", async () => {
    let down = true;
    const auction = fakeAuction({
      add: () =>
        down ? { kind: "timeout", cause: new Error("no answer") } : undefined,
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const asked = question(calls).messageId;
    await bot.handleUpdate(answer(calls, "Ваза"));

    expect(plain(last(calls))).toBe(
      "Не получилось сохранить. Это на моей стороне. Пришли ответ ещё раз через минуту.",
    );
    // Вопрос не закрыт: клавиатуру у его сообщения бот не снимал.
    const closed = () =>
      calls.some(
        (call) =>
          call.method === "editMessageReplyMarkup" &&
          (call.payload as { message_id?: number }).message_id === asked,
      );
    expect(closed()).toBe(false);

    down = false;
    // Отказ вопросом не был, поэтому последний вопрос в чате — тот же.
    await bot.handleUpdate(answer(calls, "Ваза"));

    expect(last(calls).text).toContain("<b>Лот добавлен</b>");
    expect(closed()).toBe(true);
    // Повтор создал тот же лот: идентификатор взят из кнопки вопроса.
    const created = auction.commands.map(
      (command) => (command.args as { lotId: string }).lotId,
    );
    expect(created).toHaveLength(4);
    expect(new Set(created).size).toBe(1);
    expect(auction.lots.size).toBe(1);
    // И той же командой: Auction узнаёт повтор `AddLot` по ключу.
    const keys = auction.commands
      .filter((command) => command.method === "addLot")
      .map((command) => (command.args as { opId: string }).opId);
    expect(keys).toEqual([created[0], created[0]]);
  });

  it("returns to the feed of the auction when the title question is cancelled", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    await bot.handleUpdate(press(dataOf(question(calls).payload, "Отмена")));

    // Вопрос удалён, а лента пришла новым сообщением.
    expect(calls.map((call) => call.method)).toContain("deleteMessage");
    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(last(calls).text).toContain("<b>Лоты</b>");
    expect(auction.commands).toEqual([]);
  });

  it("returns to the form of the lot when a field question is cancelled", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ask:${uuidToToken(existingLot)}:title`),
    );
    await bot.handleUpdate(press(dataOf(question(calls).payload, "Отмена")));

    expect(last(calls).text).toContain("<b>Изменить лот</b>");
    expect(last(calls).text).toContain("Название: Кружка с совой");
  });

  it("answers a form button of a lot Auction does not know with a refusal and a way to press it again", async () => {
    const auction = fakeAuction();
    const { bot, calls, records } = harness(["admin", "public"], auction);
    await bot.init();
    const pressed = `v1:lot:form:${uuidToToken(existingLot)}`;

    await bot.handleUpdate(press(pressed));

    expect(last(calls).text).toContain("Лот не найден или больше недоступен.");
    // Чтения Auction отстают от команды: только что заведённый лот появится.
    expect(labels(last(calls))).toEqual([["Повторить"], ["Меню"]]);
    expect(dataOf(last(calls), "Повторить")).toBe(pressed);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "visibility",
      error: "lot_not_found",
    });
  });
});

// Фото лота (PER-452): ответ фотографией на вопрос формы, скачивание у
// Telegram и замена изображения в карточке каталога.
describe("lot form photo question", () => {
  const lot = uuidToToken(existingLot);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  // Telegram присылает фото несколькими размерами, наибольший — последним.
  const photo = {
    photo: [
      { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
      { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
    ],
  };
  const photoQuestion =
    "Пришли фото лота ответом на это сообщение. Его увидят участники на карточке лота.";

  it("saves the photo sent in the form and shows it on the lot card after a restart", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const calls: RecordedCall[] = [];
    const next = async (
      update: (history: RecordedCall[]) => Update,
      presentation: "rich" | "plain" = "plain",
    ) => {
      const { bot } = harness(["admin", "public"], auction, calls, {
        telegram,
        presentation,
      });
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(`v1:lot:form:${lot}`));
    expect(last(calls).text).toContain("Фото: нет");
    await next(() => press(`v1:lot:ask:${lot}:image`));
    const asked = question(calls).payload;
    expect(asked.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
    // Шаг вопроса лежит в его «Отмене»: ответ после рестарта принимается.
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:li:${lot}:42`);

    await next((history) => reply(history, photo));

    expect(telegram.downloads).toEqual(["photos/large"]);
    expect(auction.commands).toEqual([
      {
        method: "editLotCard",
        args: {
          lotId: existingLot,
          title: "Кружка с совой",
          description: "Ручная роспись.",
          image: jpeg,
        },
      },
    ]);
    const form = last(calls);
    expect(form.text).toBe(
      ["<b>Фото сохранено</b>", "«Кружка с совой»"].join("\n\n"),
    );
    expect(labels(form)).toEqual([["Изменить лот"], ["‹ Лот", "Меню"]]);
    await next(() => press(dataOf(form, "Изменить лот")));
    expect(last(calls).text).toContain("Фото: есть");

    // Новый процесс с пустым кэшем `file_id` берёт фото у Auction.
    await next(() => press(lotData(existingLot)), "rich");
    const card = calls.at(-1)?.payload as {
      rich_message?: { media?: { media: { media: unknown } }[] };
    };
    expect(card.rich_message?.media?.[0]?.media.media).toBeInstanceOf(
      InputFile,
    );
  });

  it("answers a photo above the limit of Auction with the limit on a reason screen, the lot unchanged", async () => {
    const auction = fakeAuction({ lots: [scheduled], imageLimit: 4 });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls, records } = harness(["admin", "public"], auction, [], {
      telegram,
    });
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    await bot.handleUpdate(reply(calls, photo));

    const again = await reasked(
      bot,
      calls,
      "Фото больше 1 КБ, аукцион его не принял.",
    );
    expect(again.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
    expect(dataOf(again, "Отмена")).toBe(`v1:q:li:${lot}:42`);
    expect(auction.lots.get(existingLot)?.card).toEqual(scheduled.card);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });

  it("refuses with a reason screen when text, a document or a sticker comes instead of a photo, without Auction", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls, records } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    for (const content of [
      { text: "вот фото" },
      {
        document: {
          file_id: "doc",
          file_unique_id: "d",
          mime_type: "image/jpeg",
        },
      },
      {
        sticker: {
          file_id: "sticker",
          file_unique_id: "st",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        },
      },
    ]) {
      await bot.handleUpdate(reply(calls, content));
      const again = await reasked(
        bot,
        calls,
        "Нужна фотография, а не текст, файл или стикер.",
      );
      expect(again.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
      expect(dataOf(again, "Отмена")).toBe(`v1:q:li:${lot}:42`);
    }
    expect(auction.commands).toEqual([]);
    expect(records.every((record) => record.level === "info")).toBe(true);
  });

  it("refuses an album once on a reason screen and ignores its other photos", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls } = harness(["admin", "public"], auction, [], {
      telegram,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    const asked = question(calls);
    const albumPhoto = { ...photo, media_group_id: "album-1" };

    await bot.handleUpdate(reply(calls, albumPhoto));
    const refused = last(calls);
    const shownAfterFirst = shown(calls).length;
    // Второй снимок того же альбома отвечает на тот же первый вопрос.
    const second = reply(calls, albumPhoto);
    (
      second.message as { reply_to_message: { message_id: number } }
    ).reply_to_message.message_id = asked.messageId;
    await bot.handleUpdate(second);

    expect(plain(refused).split("\n")[0]).toBe(
      "Нужна одна фотография, альбом не подходит",
    );
    expect(refused.reply_markup?.force_reply).not.toBe(true);
    // Остальные снимки альбома ничего нового не показали.
    expect(shown(calls)).toHaveLength(shownAfterFirst);
    expect(telegram.downloads).toEqual([]);
    expect(auction.commands).toEqual([]);
  });

  it.each([
    [
      "Telegram does not know the file",
      fakeTelegramFiles(),
      "dependency_unavailable",
    ],
    [
      "the download breaks",
      fakeTelegramFiles({ large: jpeg }, () => ({
        kind: "failed",
        reason: "timeout",
        cause: new Error("file download failed: TimeoutError"),
      })),
      "timeout",
    ],
  ] as const)(
    "refuses with a reason screen and asks again on request when %s, the lot unchanged",
    async (_failure, telegram, category) => {
      const auction = fakeAuction({ lots: [scheduled] });
      const { bot, calls, records } = harness(
        ["admin", "public"],
        auction,
        [],
        { telegram },
      );
      await bot.init();
      await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

      await bot.handleUpdate(reply(calls, photo));

      // Запись об ответе — до нажатия «Ввести заново», которое пишет свою.
      const answered = records.at(-1);
      const again = await reasked(
        bot,
        calls,
        "Не получилось получить фото у Telegram.",
      );
      expect(again.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
      expect(auction.commands).toEqual([]);
      expect(answered?.fields).toMatchObject({
        result: "error",
        error_category: category,
        use_case: "manage_lot",
      });
      expect(JSON.stringify(records)).not.toContain("test-token");
    },
  );

  it("replaces the photo of a lot that already trades", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          status: {
            kind: "trading",
            currentPrice: rub(50_000),
            phase: "online",
          },
        },
      ],
    });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls } = harness(["admin", "public"], auction, [], {
      telegram,
    });
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    await bot.handleUpdate(reply(calls, photo));

    expect(auction.methods()).toEqual(["editLotCard"]);
    expect(last(calls).text).toContain("<b>Фото сохранено</b>");
  });
});
