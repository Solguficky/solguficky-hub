import { createHash } from "node:crypto";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import {
  type AccessRight,
  encodeAuctionCallback,
  type LotView,
  type Money,
} from "../../../auction-ui/index.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import { createDispatcher } from "../application/dispatcher.js";
import { fingerprint } from "../application/fingerprint.js";
import { lotPhotoIdOf, lotReadWindowMs } from "../application/lot-form.js";
import type { ConsoleAuctionStatus, LotSet } from "../application/types.js";
import type {
  AddLotResult,
  AuctionConsoles,
  AuctionScreens,
  LotAdministration,
  LotCardResult,
  LotPhotoResult,
  MeetupAuctions,
  ScheduleLotResult,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import { getFileTimeoutMs } from "./bot.js";
import { uuidToToken } from "./meetup-deep-link.js";
import { newLotIdOf } from "./new-lot-id.js";
import { type LotFormField, lotAskData } from "./parse-callback.js";
import { money } from "./screens/auction.js";
import type { FileDownload, TelegramFiles } from "./telegram-files.js";
import { actionBudgetMs } from "./waiting.js";

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

// Права, как их выводит Identity (RFC-016): набор `admin` несёт право вести
// аукцион с каталогом лотов (ADR-070), участник — только права хаба и ставок.
function identity(holder: "admin" | "member") {
  const rights: readonly AccessRight[] =
    holder === "admin"
      ? [
          "access-hub",
          "place-bids",
          "manage-members",
          "admit-bidders",
          "manage-meetups",
          "run-auctions",
        ]
      : ["access-hub", "place-bids"];
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      rights,
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
    edit?: (card: { lotId: string }) => LotCardResult | undefined;
    // Отказ команды фото; `undefined` — команда принята.
    photo?: () => LotPhotoResult | undefined;
    // Сколько первых принятых фото теряют ответ: Auction фото добавил, а бот
    // ответа не дождался (PER-728).
    lostPhotoAnswers?: number;
    // Бюджет действия, как у настоящего клиента: вызов после дедлайна не
    // уходит в Auction и отказывает таймаутом (PER-728).
    budget?: true;
    // Сколько первых чтений после `AddLot` read model ещё не знает лот.
    readLag?: number;
    // Пульт аукциона (PER-716): статус и сеты. Нет — форма пульта не видит.
    console?: { status?: ConsoleAuctionStatus; sets?: LotSet[] };
  } = {},
) {
  const lagging = new Map<string, number>();
  let lostPhotoAnswers = options.lostPhotoAnswers ?? 0;
  const overBudget = (meta?: RpcMetadata) =>
    options.budget === true &&
    meta?.deadlineAt !== undefined &&
    meta.deadlineAt <= Date.now();
  const budgetSpent = {
    kind: "timeout",
    cause: new Error("the action budget is exhausted"),
  } as const;
  const imageLimit = options.imageLimit ?? 1024 * 1024;
  // Обложка лота у Auction до списка фото (PER-721): карточка несёт только
  // `image`, байты отдаёт `GetLotImage`.
  const images = new Map<string, { content: Uint8Array; version: string }>();
  // Фото лота по порядку (PER-721): их отдаёт `GetLotPhoto`, первое — обложка.
  const photos = new Map<
    string,
    { photoId: string; content: Uint8Array; version: string }[]
  >();
  let photoVersions = 0;
  const photosOf = (lotId: string) => photos.get(lotId) ?? [];
  // Карточка лота несёт фото после каждой команды, как чтение Auction.
  const syncCard = (lotId: string) => {
    const lot = lots.get(lotId);
    if (lot?.card === undefined) return;
    const list = photosOf(lotId);
    const { image: _image, photos: _photos, ...text } = lot.card;
    const cover = list[0] ?? images.get(lotId);
    lots.set(lotId, {
      ...lot,
      card: {
        ...text,
        ...(cover === undefined ? {} : { image: { version: cover.version } }),
        ...(list.length === 0
          ? {}
          : {
              photos: list.map(({ photoId, version }) => ({
                photoId,
                version,
              })),
            }),
      },
    });
  };
  const refs = (lotId: string) =>
    photosOf(lotId).map(({ photoId, version }) => ({ photoId, version }));
  const lots = new Map<string, LotView>(
    (options.lots ?? []).map((lot) => [lot.lotId, lot]),
  );
  const cards = new Map<string, { title: string; description: string }>();
  // Реестр аукциона: лоты ленты. Снятый лот Auction ещё читает, но в ленте и
  // в реестре его нет.
  const registry = new Set<string>(
    (options.lots ?? []).map((lot) => lot.lotId),
  );
  const status = options.console?.status ?? "draft";
  const open = status === "draft" || status === "scheduled";
  const sets = new Map<string, LotSet>(
    (options.console?.sets ?? []).map((set) => [set.lotSetId, set]),
  );
  const commands: { method: string; args: unknown }[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const port: MeetupAuctions & AuctionScreens & LotAdministration = {
    getMeetupAuction: notUsed,
    soldLots: notUsed,
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
      const refused = options.edit?.(card);
      if (refused !== undefined && refused.kind !== "ok") return refused;
      const lot = lots.get(card.lotId);
      if (lot === undefined) return { kind: "card-not-found" };
      const image = card.image;
      if (image !== undefined && image.byteLength > imageLimit) {
        return { kind: "image-too-large", maxBytes: imageLimit };
      }
      if (image !== undefined) {
        images.set(card.lotId, {
          content: image,
          // Версия фото у Auction — SHA-256 содержимого.
          version: createHash("sha256").update(image).digest("hex"),
        });
      }
      if (card.removeImage === true) images.delete(card.lotId);
      lots.set(card.lotId, {
        ...lot,
        card: { title: card.title, description: card.description },
      });
      syncCard(card.lotId);
      return { kind: "ok" };
    },
    async addLotPhoto(_person, added, meta) {
      if (overBudget(meta)) return budgetSpent;
      commands.push({ method: "addLotPhoto", args: added });
      const refused = options.photo?.();
      if (refused !== undefined) return refused;
      if (!lots.has(added.lotId)) return { kind: "card-not-found" };
      if (added.image.byteLength > imageLimit) {
        return { kind: "image-too-large", maxBytes: imageLimit };
      }
      const list = photosOf(added.lotId);
      // Повтор того же `photoId` второго фото не заводит, как у Auction.
      if (list.some((photo) => photo.photoId === added.photoId)) {
        return { kind: "ok", photos: refs(added.lotId) };
      }
      if (list.length >= 10) return { kind: "photo-limit", maxPhotos: 10 };
      photos.set(added.lotId, [
        ...list,
        {
          photoId: added.photoId,
          content: added.image,
          // Версия фото у Auction — SHA-256 содержимого.
          version: createHash("sha256").update(added.image).digest("hex"),
        },
      ]);
      syncCard(added.lotId);
      if (lostPhotoAnswers > 0) {
        lostPhotoAnswers -= 1;
        return { kind: "timeout", cause: new Error("deadline exceeded") };
      }
      return { kind: "ok", photos: refs(added.lotId) };
    },
    async removeLotPhoto(_person, removed) {
      commands.push({ method: "removeLotPhoto", args: removed });
      const refused = options.photo?.();
      if (refused !== undefined) return refused;
      photos.set(
        removed.lotId,
        photosOf(removed.lotId).filter(
          (photo) => photo.photoId !== removed.photoId,
        ),
      );
      syncCard(removed.lotId);
      return { kind: "ok", photos: refs(removed.lotId) };
    },
    async addLot(_person, added) {
      commands.push({ method: "addLot", args: added });
      const refused = options.add?.();
      if (refused !== undefined) return refused;
      if (!open) return { kind: "lots-frozen" };
      registry.add(added.lotId);
      const card = cards.get(added.lotId);
      lots.set(added.lotId, {
        lotId: added.lotId,
        auctionId: added.auctionId,
        version: 1,
        ...(card === undefined ? {} : { card }),
        proxyEnabled: false,
        status: { kind: "draft" },
      });
      lagging.set(added.lotId, options.readLag ?? 0);
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
        ...(terms.stepPolicy.kind === "fixed"
          ? { fixedStep: terms.stepPolicy.step }
          : { tiers: terms.stepPolicy.tiers }),
        status: { kind: "scheduled", startingPrice: terms.startingPrice },
      });
      return { kind: "ok" };
    },
    async getLot(_person, lotId, meta) {
      if (overBudget(meta)) return budgetSpent;
      const behind = lagging.get(lotId) ?? 0;
      if (behind > 0) {
        lagging.set(lotId, behind - 1);
        return { kind: "not-found" };
      }
      const lot = lots.get(lotId);
      return lot === undefined ? { kind: "not-found" } : { kind: "ok", lot };
    },
    async removeLot(_person, removed) {
      commands.push({ method: "removeLot", args: removed });
      if (!open) return { kind: "lots-frozen" };
      if (!registry.delete(removed.lotId))
        return { kind: "lot-not-in-auction" };
      // Снятый лот уходит и из сета (ADR-073, п. 3).
      for (const [id, set] of sets) {
        sets.set(id, {
          ...set,
          lotIds: set.lotIds.filter((lotId) => lotId !== removed.lotId),
        });
      }
      return { kind: "ok" };
    },
    async getLotImage(_person, lotId) {
      const stored = images.get(lotId);
      return stored === undefined
        ? { kind: "not-found" }
        : { kind: "ok", content: stored.content, version: stored.version };
    },
    async getLotPhoto(_person, { lotId, photoId }) {
      const stored = photosOf(lotId).find((photo) => photo.photoId === photoId);
      return stored === undefined
        ? { kind: "not-found" }
        : { kind: "ok", content: stored.content, version: stored.version };
    },
    currentAuction: async () => ({ kind: "ok" as const }),
    screenPorts() {
      return {
        auction: {
          findLot: async () => undefined,
          async getLot({ lotId }) {
            const lot = lots.get(lotId);
            if (lot === undefined) throw new Error("lot not found");
            return lot;
          },
          listAuctionLots: async () => ({
            lots: [...lots.values()].filter((lot) => registry.has(lot.lotId)),
            nextPageToken: "",
          }),
          listLotHistory: async () => ({ entries: [], nextPageToken: "" }),
          getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
          getDisplayNames: async () => ({}),
          placeBid: async () => ({ kind: "accepted", lotVersion: 0 }),
          setProxyLimit: async () => ({ kind: "accepted", lotVersion: 0 }),
          chooseDisplayName: async () => ({ kind: "accepted", name: "@owl" }),
          getAuction: async () => undefined,
          getRaffle: async () => undefined,
          registerForRaffle: async () => {
            throw new Error("not used");
          },
          cancelRaffleRegistration: async () => {
            throw new Error("not used");
          },
          listMyInvoices: async () => ({ invoices: [] }),
          chooseFulfillment: async () => {
            throw new Error("not used");
          },
          getMyPredictions: async () => [],
          getPredictionResults: async () => {
            throw new Error("not used");
          },
          submitPrediction: async () => {
            throw new Error("not used");
          },
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
          async getLotPhoto({ lotId, photoId }) {
            const stored = photosOf(lotId).find(
              (photo) => photo.photoId === photoId,
            );
            if (stored === undefined) throw new Error("no photo");
            return { ...stored, mediaType: "image/jpeg" };
          },
        },
      };
    },
  };
  // Пульт для формы (PER-716): реестр и сеты из одного состояния с лотами.
  const consoles: Pick<AuctionConsoles, "getAuctionConsole" | "saveLotSet"> = {
    async getAuctionConsole() {
      return {
        kind: "ok",
        console: {
          auctionId,
          status,
          hidden: false,
          launchedWindows: [],
          lots: [...registry].flatMap((lotId) => {
            const lot = lots.get(lotId);
            return lot === undefined
              ? []
              : [{ lot, bidCount: 0, markedForFinal: false, overdue: false }];
          }),
          lotSets: [...sets.values()].sort((a, b) =>
            a.lotSetId < b.lotSetId ? -1 : 1,
          ),
        },
      };
    },
    async saveLotSet(_person, set) {
      commands.push({ method: "saveLotSet", args: set });
      if (!open) return { kind: "lots-frozen" };
      sets.set(set.lotSetId, {
        lotSetId: set.lotSetId,
        name: set.name,
        lotIds: [...set.lotIds],
      });
      return { kind: "ok" };
    },
  };
  return {
    port,
    lots,
    images,
    photos,
    // Карточка лота по фото после правки `photos` в обход команд.
    resync: syncCard,
    commands,
    registry,
    sets,
    consoles: options.console === undefined ? undefined : consoles,
    // Фото лота с готовыми байтами, как их завела бы форма.
    seedPhotos(lotId: string, count: number) {
      const content = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      photos.set(
        lotId,
        Array.from({ length: count }, (_, index) => {
          photoVersions += 1;
          return {
            photoId: `0198f2a4-7c1e-7d3a-9b21-0000000000${String(index + 1).padStart(2, "0")}`,
            content,
            version: `img-${photoVersions}`,
          };
        }),
      );
      syncCard(lotId);
    },
    methods: () => commands.map((command) => command.method),
  };
}

// Новый бот над тем же Auction и той же историей чата: так выглядит рестарт.
function harness(
  holder: "admin" | "member",
  auction: ReturnType<typeof fakeAuction>,
  calls: RecordedCall[] = [],
  options: {
    presentation?: "rich" | "plain";
    telegram?: ReturnType<typeof fakeTelegramFiles>;
  } = {},
) {
  const telegram = options.telegram ?? fakeTelegramFiles();
  return createHarness(
    identity(holder),
    createDispatcher(
      undefined,
      undefined,
      undefined,
      auction.port,
      auction.port,
      auction.consoles === undefined
        ? undefined
        : {
            // Форме нужны только чтение пульта и сохранение сета.
            auctions: auction.consoles as AuctionConsoles,
            timeZone: "Europe/Moscow",
          },
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
// отдаёт байты. Файл, которого тест не завёл, `getFile` не знает. `delays` —
// задержки ответов `getFile` по порядку вызовов (PER-728), `Infinity` — ответа
// нет вовсе.
function fakeTelegramFiles(
  stored: Record<string, Uint8Array> = {},
  download?: (path: string) => FileDownload | Promise<FileDownload>,
  delays: number[] = [],
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
    const answer =
      fileId in stored
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
    const delay = delays.shift() ?? 0;
    if (delay === 0) return answer;
    return new Promise((resolve) => {
      if (delay !== Number.POSITIVE_INFINITY) {
        setTimeout(() => resolve(answer), delay);
      }
    });
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
      // Свой номер у каждого ответа; идентификатор фото бот выводит из лота
      // и байтов, а не из номера сообщения.
      message_id: 1000 + calls.length,
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
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(feedData));
    const feed = last(calls);
    // Над списком лотов — только «Добавить лот»: пульт и правила стоят в
    // корне аукциона (PER-605).
    expect(labels(feed)[0]).toEqual(["🛠 Добавить лот"]);
    expect(dataOf(feed, "🛠 Добавить лот")).toBe(`v1:lot:new:${auctionToken}`);

    await bot.handleUpdate(press(lotData(existingLot)));
    const card = last(calls);
    expect(labels(card)).toContainEqual(["🛠 Изменить лот"]);
    expect(dataOf(card, "🛠 Изменить лот")).toBe(
      `v1:lot:form:${uuidToToken(existingLot)}`,
    );
  });

  it("shows a member neither entry", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness("member", auction);
    await bot.init();

    await bot.handleUpdate(press(feedData));
    await bot.handleUpdate(press(lotData(existingLot)));

    const text = JSON.stringify(shown(calls));
    expect(text).not.toContain("🛠 Добавить лот");
    expect(text).not.toContain("🛠 Изменить лот");
  });

  it("refuses a form button and an answer of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    // Вопрос остался в чате от администратора; роль с тех пор сняли.
    const asked = harness("admin", auction);
    await asked.bot.init();
    await asked.bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const member = harness("member", auction);
    await member.bot.init();

    for (const data of [
      `v1:lot:new:${auctionToken}`,
      `v1:lot:form:${uuidToToken(existingLot)}`,
      `v1:lot:view:${uuidToToken(existingLot)}`,
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the title, adds the lot to the auction and goes on with the price instead of an outcome screen", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
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
    // Цепочка нового лота (PER-618): после названия форма сама спрашивает
    // цену, а не обрывается экраном «Лот добавлен».
    const price = question(calls).payload;
    expect(price.text).toBe(
      [
        "Лот добавлен. Без цены и шага он не выйдет на торги.",
        "Стартовая цена в рублях, целым числом. Например: 1500",
      ].join("\n"),
    );
    expect(labels(price)).toEqual([["Отмена"]]);
    expect(dataOf(price, "Отмена")).toBe(`v1:q:cp:${uuidToToken(lotId)}:42`);
    // Форма с недостающими полями — «Отмена» под вопросом цепочки.
    await bot.handleUpdate(press(dataOf(price, "Отмена")));
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
    // Поля по два в ряд со знаками (прогон 12.10, №17 и №18).
    expect(labels(opened)).toEqual([
      ["🔖 Название", "📝 Описание"],
      ["🖼 Фото", "💰 Цена и шаг"],
      ["Глазами участника"],
      ["‹ Лот"],
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
      const { bot } = harness("admin", auction, calls);
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

    // Цена ушла в кнопку выбора способа шага, а не в память и не в Auction.
    const mode = last(calls);
    expect(labels(mode)).toEqual([
      ["Один шаг", "По порогам"],
      ["‹ Изменить лот"],
    ]);
    expect(plain(mode)).toContain("Как задать шаг?");
    expect(auction.methods()).toEqual(["createLotCard", "addLot"]);

    // Способ едет в кнопке: вопрос о шаге задаётся и после рестарта.
    await next((history) => press(dataOf(last(history), "Один шаг")));
    const step = question(calls).payload;
    expect(dataOf(step, "Отмена")).toBe(
      `v1:q:ls:${uuidToToken(lotId)}:1500:42`,
    );
    expect(step.text).toContain("Шаг ставки в рублях");

    await next((history) => answer(history, "100"));

    expect(auction.commands.at(-1)).toEqual({
      method: "scheduleLot",
      args: {
        auctionId,
        lotId,
        opId: expect.any(String),
        startingPrice: rub(150_000),
        stepPolicy: { kind: "fixed", step: rub(10_000) },
      },
    });
    const form = last(calls);
    expect(form.text).toBe(
      ["<b>Цена и шаг сохранены</b>", "<b>Ваза</b>"].join("\n\n"),
    );
    expect(labels(form)).toEqual([["Изменить лот"], ["‹ Лот"]]);
    // Значения видны на форме, которую открывает «Изменить лот».
    await next(() => press(dataOf(form, "Изменить лот")));
    expect(last(calls).text).toContain("Стартовая цена: 1 500 ₽");
    expect(last(calls).text).toContain("Шаг: 100 ₽");
    // Заведённый формой лот стоит в ленте аукциона сходки со стартовой ценой.
    await next(() => press(feedData));
    expect(JSON.stringify(last(calls))).toContain("Ваза · старт 1 500 ₽");
  });

  // Прогон dev 24.10 (PER-714): админ меняет только цену, а шаг оставляет.
  const { fixedStep: _single, ...unstepped } = scheduled;
  const tieredLot: LotView = {
    ...unstepped,
    tiers: [
      { lowerBound: rub(0), step: rub(10_000) },
      { lowerBound: rub(500_000), step: rub(25_000) },
    ],
  };
  it.each([
    [
      "single step",
      scheduled,
      `Оставить шаг ${money(rub(10_000))}`,
      { kind: "fixed", step: rub(10_000) },
    ],
    [
      "thresholds",
      tieredLot,
      "Оставить пороги шага",
      { kind: "tiered", tiers: tieredLot.tiers },
    ],
  ])(
    "saves a new price with the lot's %s kept by one press over a restart",
    async (_, lot, keep, stepPolicy) => {
      const auction = fakeAuction({ lots: [lot] });
      const calls: RecordedCall[] = [];
      const next = async (update: (history: RecordedCall[]) => Update) => {
        const { bot } = harness("admin", auction, calls);
        await bot.init();
        await bot.handleUpdate(update(calls));
      };
      const token = uuidToToken(existingLot);

      await next(() => press(`v1:lot:ask:${token}:price`));
      await next((history) => answer(history, "2 500"));

      // Экран говорит до ухода, что цена без шага не сохранится, и даёт оставить
      // прежний шаг; цена едет в кнопке.
      const mode = last(calls);
      expect(labels(mode)).toEqual([
        ["Один шаг", "По порогам"],
        [keep],
        ["‹ Изменить лот"],
      ]);
      expect(dataOf(mode, keep)).toBe(`v1:lot:sk:${token}:2500`);
      expect(plain(mode)).toContain(
        "Цена сохранится только вместе с шагом: «‹ Изменить лот» её не сохранит.",
      );

      await next((history) => press(dataOf(last(history), keep)));

      expect(auction.commands).toEqual([
        {
          method: "scheduleLot",
          args: {
            auctionId,
            lotId: existingLot,
            opId: expect.any(String),
            startingPrice: rub(250_000),
            stepPolicy,
          },
        },
      ]);
      const saved = last(calls);
      expect(plain(saved)).toBe(
        ["Цена и шаг сохранены", "Кружка с совой"].join("\n\n"),
      );
      expect(labels(saved)).toEqual([["Изменить лот"], ["‹ Лот"]]);
    },
  );

  it("leaves the price unsaved when the administrator goes back from choosing the step", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const token = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:ask:${token}:price`));
    await bot.handleUpdate(answer(calls, "2 500"));
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Изменить лот")));

    expect(auction.commands).toEqual([]);
    expect(last(calls).text).toMatch(/Стартовая цена: 500\s₽/);
  });

  it("offers no kept step in the chain of a new lot", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    await bot.handleUpdate(answer(calls, "Ваза"));
    await bot.handleUpdate(answer(calls, "1 500"));

    const mode = last(calls);
    expect(labels(mode)).toEqual([
      ["Один шаг", "По порогам"],
      ["‹ Изменить лот"],
    ]);
    expect(plain(mode)).not.toContain("Цена сохранится только");
  });

  it("ignores an answer to a question of the form from anyone but the asked after a restart", async () => {
    const auction = fakeAuction();
    const calls: RecordedCall[] = [];
    const first = harness("admin", auction, calls);
    await first.bot.init();
    await first.bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    const shownBefore = shown(calls).length;

    // Новый бот знает спрашиваемого только из кнопки вопроса (PER-461).
    const second = harness("admin", auction, calls);
    await second.bot.init();
    await second.bot.handleUpdate(answer(calls, "Чужая ваза", 77));

    expect(auction.methods()).toEqual([]);
    expect(shown(calls)).toHaveLength(shownBefore);

    await second.bot.handleUpdate(answer(calls, "Ваза"));

    expect(auction.methods()).toEqual(["createLotCard", "addLot"]);
  });

  it("answers a price or a step that is not a number with a reason screen and the question again on request, not an exception", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls, records } = harness("admin", auction);
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
    expect(labels(refusal)).toEqual([["Ввести заново"], ["‹ Лот"]]);
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
    // Цена принята: способ шага выбирается кнопкой (PER-491).
    await bot.handleUpdate(press(dataOf(last(calls), "Один шаг")));
    await bot.handleUpdate(answer(calls, "0"));

    // «Ввести заново» после шага задаёт тот же вопрос о шаге: цена уже в нём.
    const step = await reasked(bot, calls, "Сумма — от 1 до 9 999 999 рублей.");
    expect(step.text).toContain("Шаг ставки в рублях");
    expect(dataOf(step, "Отмена")).toBe(`v1:q:ls:${lot}:700:42`);

    await bot.handleUpdate(answer(calls, "50"));
    expect(auction.commands.map((command) => command.method)).toEqual([
      "scheduleLot",
    ]);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });

  it("asks the thresholds again after a refused threshold answer, keeping the price", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    const lot = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:price`));
    await bot.handleUpdate(answer(calls, "1500"));
    await bot.handleUpdate(press(dataOf(last(calls), "По порогам")));
    // Вопрос объясняет, что пороги — по цене лота от 0, с расшифровкой.
    expect(question(calls).payload.text).toContain(
      [
        "Пороги шага — строками «от цены — шаг». Цена считается от 0, а не от стартовой: первый порог всегда 0. Дальше цены растут, а шаг не уменьшается. Например:",
        "0 — 100",
        "5000 — 250",
        "До 5 000 ₽ шаг 100 ₽, с 5 000 ₽ — 250 ₽.",
      ].join("\n"),
    );
    // Прогон dev 24.10: пороги начаты со стартовой цены.
    await bot.handleUpdate(answer(calls, "1500 — 100\n3000 — 200"));

    // Отказ называет первый порог и предлагает те же строки с нуля.
    expect(plain(last(calls))).toBe(
      [
        "Первый порог — 0",
        "",
        "Пороги считаются по цене лота от 0, а не от стартовой цены. Пришли так:",
        "0 — 100",
        "3000 — 200",
      ].join("\n"),
    );
    // Повтор — снова пороги при цене 1 500 ₽, а не вопрос о стартовой цене.
    const again = await reasked(bot, calls, "Первый порог — 0.");
    expect(again.text).toContain("Пороги шага — строками");
    expect(again.text).toMatch(/^Стартовая цена: 1\s500\s₽\./);
    expect(dataOf(again, "Отмена")).toBe(`v1:q:ly:${lot}:1500:42`);
    expect(auction.commands).toEqual([]);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });

  it.each([
    [
      "whose step decreases",
      "0 — 500\n5000 — 100",
      "Шаг не может уменьшаться",
      "С ростом цены шаг остаётся прежним или растёт. Например:",
    ],
    [
      "whose prices do not ascend",
      "0 — 100\n5000 — 250\n3000 — 300",
      "Цены порогов не по возрастанию",
      "Каждый следующий порог — с цены выше прежнего. Например:",
    ],
  ])(
    "refuses thresholds %s with its own reason",
    async (_, value, title, explanation) => {
      const auction = fakeAuction({ lots: [scheduled] });
      const { bot, calls } = harness("admin", auction);
      await bot.init();
      const lot = uuidToToken(existingLot);

      await bot.handleUpdate(press(`v1:lot:ask:${lot}:price`));
      await bot.handleUpdate(answer(calls, "1000"));
      await bot.handleUpdate(press(dataOf(last(calls), "По порогам")));
      await bot.handleUpdate(answer(calls, value));

      expect(plain(last(calls))).toBe(
        [title, "", explanation, "0 — 100", "5000 — 250"].join("\n"),
      );
      const again = await reasked(bot, calls, `${title}.`);
      expect(dataOf(again, "Отмена")).toBe(`v1:q:ly:${lot}:1000:42`);
      expect(auction.commands).toEqual([]);
    },
  );

  it("changes one text of the card and shows the outcome with a way back to the form", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness("admin", auction);
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
      ["<b>Изменение сохранено</b>", "<b>Кружка с совой</b>"].join("\n\n"),
    );
    expect(labels(saved)).toEqual([["Изменить лот"], ["‹ Лот"]]);
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
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const lot = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:form:${lot}`));
    const form = last(calls);
    // Фото — каталог, а не условия торгов: его ряд остаётся (ADR-057).
    expect(labels(form)).toEqual([
      ["🔖 Название", "📝 Описание"],
      ["🖼 Фото"],
      ["Глазами участника"],
      ["‹ Лот"],
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

  it("closes the title, description and photo of a sold lot, also to an old button and an old question", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const lot = uuidToToken(existingLot);
    // Вопрос о названии задан, пока лот не продан.
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:title`));
    const asked = calls.length;
    auction.lots.set(existingLot, {
      ...scheduled,
      status: { kind: "sold", winnerId: existingLot, price: rub(90_000) },
    });

    await bot.handleUpdate(answer(calls.slice(0, asked), "Новое название"));
    expect(plain(last(calls))).toBe(
      "Лот продан. Название, описание и фото больше не меняются.",
    );

    await bot.handleUpdate(press(`v1:lot:form:${lot}`));
    const form = last(calls);
    // У проданного лота правка закрыта; цена продажи — вместо подписи торгов.
    expect(labels(form)).toEqual([["Глазами участника"], ["‹ Лот"]]);
    expect(form.text).toMatch(
      /Лот продан за 900\s₽: название, описание и фото больше не меняются\./,
    );
    expect(form.text).not.toContain("Торги по лоту начались");

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    expect(plain(last(calls))).toBe(
      "Лот продан. Название, описание и фото больше не меняются.",
    );
    expect(
      auction.commands.filter((command) => command.method === "editLotCard"),
    ).toEqual([]);
  });

  it("shows a closed-card frame with a return to the lot when Auction refuses the edit", async () => {
    const auction = fakeAuction({
      lots: [{ ...scheduled, status: { kind: "unsold" } }],
      edit: () => ({ kind: "card-closed" }),
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const lot = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:title`));
    await bot.handleUpdate(answer(calls, "Новое название"));

    const refusal = last(calls);
    expect(plain(refusal)).toBe(
      "Лот закрыт. Название, описание и фото больше не меняются.",
    );
    expect(labels(refusal)).toEqual([["‹ Лот"]]);
    expect(auction.lots.get(existingLot)?.card?.title).toBe("Кружка с совой");
  });

  it("tells the administrator that trading started when Auction freezes the terms after both answers", async () => {
    const auction = fakeAuction({
      lots: [scheduled],
      schedule: () => ({ kind: "lots-frozen" }),
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ask:${uuidToToken(existingLot)}:price`),
    );
    await bot.handleUpdate(answer(calls, "700"));
    await bot.handleUpdate(press(dataOf(last(calls), "Один шаг")));
    await bot.handleUpdate(answer(calls, "50"));

    const refusal = last(calls);
    expect(plain(refusal)).toBe(
      "Торги уже начались. Цену и шаг лота изменить нельзя.",
    );
    expect(labels(refusal)).toEqual([["‹ Лот"]]);
    expect(auction.lots.get(existingLot)?.status).toEqual(scheduled.status);
  });

  it("leaves the question open when Auction does not answer, so the same title can be sent again", async () => {
    let down = true;
    const auction = fakeAuction({
      add: () =>
        down ? { kind: "timeout", cause: new Error("no answer") } : undefined,
    });
    const { bot, calls } = harness("admin", auction);
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

    expect(question(calls).payload.text).toContain("Лот добавлен.");
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
    const { bot, calls } = harness("admin", auction);
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
    const { bot, calls } = harness("admin", auction);
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
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    const pressed = `v1:lot:form:${uuidToToken(existingLot)}`;

    // Отказ приходит, когда выходит окно ожидания read model (PER-471).
    vi.useFakeTimers();
    const handled = bot.handleUpdate(press(pressed));
    await vi.advanceTimersByTimeAsync(lotReadWindowMs);
    await handled;

    expect(last(calls).text).toContain("Лот не найден или больше недоступен.");
    // Чтения Auction отстают от команды: только что заведённый лот появится.
    expect(labels(last(calls))).toEqual([["Повторить"], ["‹ Сходки"]]);
    expect(dataOf(last(calls), "Повторить")).toBe(pressed);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "visibility",
      error: "lot_not_found",
    });
  });

  // Read model Auction отстаёт от команды: нажатие сразу после названия
  // читает лот, которого она ещё не знает (PER-471).
  it.each([
    ["image", "Пришли фото лота"],
    ["description", "Сейчас: нет"],
    ["price", "Стартовая цена в рублях"],
  ] as const satisfies readonly (readonly [LotFormField, string])[])(
    "asks the %s of a just added lot the read model does not know yet",
    async (field, asked) => {
      const auction = fakeAuction({ readLag: 1 });
      const { bot, calls, records } = harness("admin", auction);
      await bot.init();
      await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
      const step = dataOf(question(calls).payload, "Отмена");
      const lotId = newLotIdOf(step.split(":")[4] ?? "");
      await bot.handleUpdate(answer(calls, "Ваза синяя"));
      expect(question(calls).payload.text).toContain("Лот добавлен.");

      vi.useFakeTimers();
      const handled = bot.handleUpdate(
        press(lotAskData(uuidToToken(lotId), field)),
      );
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);
      await handled;

      expect(question(calls).payload.text).toContain(asked);
      expect(records.at(-1)?.fields).toMatchObject({ result: "ok" });
    },
  );
});

// Фото лота (PER-452, PER-721): экран «Фото лота», ответ фотографией на вопрос
// формы, скачивание у Telegram и добавление фото в конец списка у Auction.
describe("lot form photos", () => {
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
    "Пришли фото лота ответом на это сообщение — одно или альбомом. Фото встанут в конец, у лота их бывает до 10.";
  const otherJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
  const photoOf = (fileId: string) => ({
    photo: [
      { file_id: fileId, file_unique_id: fileId, width: 800, height: 800 },
    ],
  });

  it("adds photos from the photo screen over restarts, counts them in the form and shows a carousel on the card", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const telegram = fakeTelegramFiles({ large: jpeg, other: otherJpeg });
    const calls: RecordedCall[] = [];
    const next = async (
      update: (history: RecordedCall[]) => Update,
      presentation: "rich" | "plain" = "plain",
    ) => {
      const { bot } = harness("admin", auction, calls, {
        telegram,
        presentation,
      });
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(`v1:lot:form:${lot}`));
    const form = last(calls);
    expect(form.text).toContain("Фото: нет");
    await next(() => press(dataOf(form, "🖼 Фото")));
    const screen = last(calls);
    expect(plain(screen)).toBe(
      "Фото лота\n<i>Кружка с совой</i>\n\nФото пока нет.",
    );
    expect(labels(screen)).toEqual([["Добавить фото"], ["‹ Изменить лот"]]);

    await next(() => press(dataOf(screen, "Добавить фото")));
    const asked = question(calls).payload;
    expect(asked.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
    // Шаг вопроса лежит в его «Отмене»: ответ после рестарта принимается.
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:li:${lot}:42`);

    await next((history) => reply(history, photo));
    expect(telegram.downloads).toEqual(["photos/large"]);
    expect(auction.methods()).toEqual(["addLotPhoto"]);
    expect(auction.commands[0]?.args).toMatchObject({
      lotId: existingLot,
      image: jpeg,
    });
    const added = last(calls);
    expect(plain(added)).toBe(
      ["Фото добавлено", "Кружка с совой", "Фото у лота: 1 из 10."].join(
        "\n\n",
      ),
    );
    expect(labels(added)).toEqual([["Фото лота"], ["‹ Лот"]]);

    // Второе фото тем же путём встаёт в конец.
    await next(() => press(dataOf(added, "Фото лота")));
    await next(() => press(dataOf(last(calls), "Добавить фото")));
    expect(question(calls).payload.text).toBe(
      ["Сейчас: фото 1 из 10, новое встанет в конец", photoQuestion].join("\n"),
    );
    await next((history) => reply(history, photoOf("other")));
    expect(plain(last(calls))).toContain("Фото у лота: 2 из 10.");
    // Идентификатор у другого фото свой.
    const ids = auction.commands.map(
      (command) => (command.args as { photoId: string }).photoId,
    );
    expect(new Set(ids).size).toBe(2);

    await next(() => press(`v1:lot:form:${lot}`));
    expect(last(calls).text).toContain("Фото: 2");

    // Новый процесс с пустым кэшем `file_id` берёт оба фото у Auction и
    // ставит их каруселью над заголовком.
    await next(() => press(lotData(existingLot)), "rich");
    const card = calls.at(-1)?.payload as {
      rich_message?: { html?: string; media?: { media: { media: unknown } }[] };
    };
    expect(card.rich_message?.media).toHaveLength(2);
    expect(card.rich_message?.media?.[1]?.media.media).toBeInstanceOf(
      InputFile,
    );
    expect(card.rich_message?.html).toMatch(
      /^<tg-slideshow><img src="tg:\/\/photo\?id=lot"\/><img src="tg:\/\/photo\?id=lot2"\/><\/tg-slideshow><h1>/,
    );
  });

  it("adds every photo of an album and shows one outcome that counts them", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const telegram = fakeTelegramFiles({
      a1: new Uint8Array([0xff, 0xd8, 1]),
      a2: new Uint8Array([0xff, 0xd8, 2]),
      a3: new Uint8Array([0xff, 0xd8, 3]),
    });
    const { bot, calls } = harness("admin", auction, [], { telegram });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    const asked = question(calls);

    // Снимки альбома отвечают на один вопрос: первый его закрывает.
    for (const file of ["a1", "a2", "a3"]) {
      const update = reply(calls, {
        ...photoOf(file),
        media_group_id: "album-1",
      });
      (
        update.message as { reply_to_message: { message_id: number } }
      ).reply_to_message.message_id = asked.messageId;
      await bot.handleUpdate(update);
    }

    expect(auction.methods()).toEqual([
      "addLotPhoto",
      "addLotPhoto",
      "addLotPhoto",
    ]);
    expect(auction.photos.get(existingLot)).toHaveLength(3);
    // Один исход на альбом: второй и третий снимки правят его на месте.
    const outcomes = calls.filter((call) =>
      ((call.payload as Sent).text ?? "").includes("Фото добавлено"),
    );
    expect(outcomes.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageText",
    ]);
    expect(plain(outcomes.at(-1)?.payload as Sent)).toContain(
      "Фото у лота: 3 из 10.",
    );
  });

  it("adds no second photo when the same photo comes again, redelivered or resent", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls } = harness("admin", auction, [], { telegram });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    const update = reply(calls, photo);

    await bot.handleUpdate(update);
    await bot.handleUpdate(structuredClone(update));
    // Ответ Auction не дошёл, и администратор прислал то же фото заново.
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    await bot.handleUpdate(reply(calls, photo));

    const ids = auction.commands.map(
      (command) => (command.args as { photoId: string }).photoId,
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(auction.photos.get(existingLot)).toHaveLength(1);
  });

  it("refuses the eleventh photo with the reason and leaves the ten", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    auction.seedPhotos(existingLot, 10);
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls, records } = harness("admin", auction, [], {
      telegram,
    });
    await bot.init();

    // На экране фото у полного лота добавить нечего.
    await bot.handleUpdate(press(`v1:lot:ph:${lot}`));
    const screen = last(calls);
    expect(labels(screen)[0]).toEqual(["🗑 Убрать фото 1"]);
    expect(plain(screen)).toContain(
      "Больше 10 фото у лота не бывает: чтобы добавить новое, убери одно.",
    );

    // Вопрос, заданный раньше, получает отказ Auction с причиной.
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    await bot.handleUpdate(reply(calls, photo));

    const refusal = last(calls);
    expect(plain(refusal)).toBe(
      "У лота уже 10 фото — больше не бывает. Чтобы добавить новое, убери одно в «Фото лота».",
    );
    expect(labels(refusal)).toEqual([["‹ Лот"]]);
    expect(auction.photos.get(existingLot)).toHaveLength(10);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });

  it("answers a photo above the limit of Auction with the limit on a reason screen, the lot unchanged", async () => {
    const auction = fakeAuction({ lots: [scheduled], imageLimit: 4 });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls, records } = harness("admin", auction, [], {
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
    const { bot, calls, records } = harness("admin", auction);
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
      const { bot, calls, records } = harness("admin", auction, [], {
        telegram,
      });
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

  it("adds a photo to a lot that already trades", async () => {
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
    const { bot, calls } = harness("admin", auction, [], {
      telegram,
    });
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));
    await bot.handleUpdate(reply(calls, photo));

    expect(auction.methods()).toEqual(["addLotPhoto"]);
    expect(last(calls).text).toContain("Фото добавлено");
  });
});

// Медленный Telegram и Auction на ответе фото (PER-728): у `getFile` свой срок
// и один повтор, бюджет Auction считается после скачивания, а сбой на любом
// шаге оставляет вопрос о фото открытым с причиной, без кадра сбоя.
describe("lot photo answer under a slow Telegram", () => {
  const lot = uuidToToken(existingLot);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const photo = {
    photo: [
      { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
    ],
  };
  const photoQuestion =
    "Пришли фото лота ответом на это сообщение — одно или альбомом. Фото встанут в конец, у лота их бывает до 10.";

  afterEach(() => {
    vi.useRealTimers();
  });

  // Ответ фото идёт, пока часы двигает тест.
  async function answerWithin(
    bot: { handleUpdate: (update: Update) => Promise<void> },
    update: Update,
    ms: number,
  ) {
    vi.useFakeTimers();
    const handled = bot.handleUpdate(update);
    await vi.advanceTimersByTimeAsync(ms);
    await handled;
    vi.useRealTimers();
  }

  it("asks getFile again after its own deadline and adds the photo", async () => {
    const auction = fakeAuction({ lots: [scheduled], budget: true });
    const telegram = fakeTelegramFiles({ large: jpeg }, undefined, [
      Number.POSITIVE_INFINITY,
    ]);
    const { bot, calls, records } = harness("admin", auction, [], {
      telegram,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    await answerWithin(bot, reply(calls, photo), getFileTimeoutMs + 1);

    expect(calls.filter((call) => call.method === "getFile")).toHaveLength(2);
    expect(auction.methods()).toEqual(["addLotPhoto"]);
    expect(last(calls).text).toContain("Фото добавлено");
    expect(records.at(-1)?.fields).toMatchObject({ result: "ok" });
  });

  it("keeps the photo question open with a reason when getFile is slow twice", async () => {
    const auction = fakeAuction({ lots: [scheduled], budget: true });
    const telegram = fakeTelegramFiles({ large: jpeg }, undefined, [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]);
    const { bot, calls, records } = harness("admin", auction, [], {
      telegram,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    await answerWithin(bot, reply(calls, photo), 2 * getFileTimeoutMs + 1);

    expect(calls.filter((call) => call.method === "getFile")).toHaveLength(2);
    expect(auction.commands).toEqual([]);
    const answered = records.at(-1);
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Лот"]]);
    expect(plain(last(calls))).toContain("Пришли фото ещё раз.");
    const again = await reasked(
      bot,
      calls,
      "Не получилось получить фото у Telegram.",
    );
    expect(again.text).toBe(["Сейчас: нет", photoQuestion].join("\n"));
    expect(answered?.fields).toMatchObject({
      result: "error",
      error_category: "timeout",
      use_case: "manage_lot",
    });
  });

  it("does not let a slow getFile within its deadline spend the budget of AddLotPhoto", async () => {
    const auction = fakeAuction({ lots: [scheduled], budget: true });
    // `getFile` в пределах своего срока и скачивание байтов вместе дольше
    // бюджета действия: от начала update на Auction не осталось бы ничего.
    const slow = getFileTimeoutMs - 1_000;
    const bytes = 1_500;
    expect(slow + bytes).toBeGreaterThan(actionBudgetMs);
    const telegram = fakeTelegramFiles(
      { large: jpeg },
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: "ok", bytes: jpeg }), bytes),
        ),
      [slow],
    );
    const { bot, calls } = harness("admin", auction, [], { telegram });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    await answerWithin(bot, reply(calls, photo), slow + bytes);

    expect(calls.filter((call) => call.method === "getFile")).toHaveLength(1);
    expect(auction.methods()).toEqual(["addLotPhoto"]);
    expect(last(calls).text).toContain("Фото добавлено");
  });

  it("keeps the photo question open when AddLotPhoto times out, and the same photo again adds no second one", async () => {
    const auction = fakeAuction({ lots: [scheduled], lostPhotoAnswers: 1 });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls, records } = harness("admin", auction, [], {
      telegram,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    await bot.handleUpdate(reply(calls, photo));

    const answered = records.at(-1);
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Лот"]]);
    expect(plain(last(calls))).toContain("Пришли фото ещё раз.");
    expect(answered?.fields).toMatchObject({
      result: "error",
      error_category: "timeout",
      use_case: "manage_lot",
    });
    await reasked(bot, calls, "Не получилось сохранить фото.");

    await bot.handleUpdate(reply(calls, photo));

    expect(auction.methods()).toEqual(["addLotPhoto", "addLotPhoto"]);
    expect(auction.commands[0]?.args).toEqual(auction.commands[1]?.args);
    expect(auction.photos.get(existingLot)).toHaveLength(1);
    expect(plain(last(calls))).toContain("Фото у лота: 1 из 10.");
  });

  it("keeps the photo question of the chain in the chain when AddLotPhoto times out", async () => {
    const auction = fakeAuction({ lots: [scheduled], lostPhotoAnswers: 1 });
    const telegram = fakeTelegramFiles({ large: jpeg });
    const { bot, calls } = harness("admin", auction, [], { telegram });
    await bot.init();
    await bot.handleUpdate(press(lotAskData(lot, "image", true)));
    const step = dataOf(question(calls).payload, "Отмена");

    await bot.handleUpdate(reply(calls, photo));
    await reasked(bot, calls, "Не получилось сохранить фото.");

    expect(dataOf(question(calls).payload, "Отмена")).toBe(step);
    await bot.handleUpdate(reply(calls, photo));
    expect(auction.photos.get(existingLot)).toHaveLength(1);
    expect(plain(last(calls))).toContain("Лот готов");
  });
});

// Снятие фото лота (PER-715, PER-721): экран «Фото лота» даёт «Убрать фото N»
// с подтверждением, а «Да» снимает то фото, которое подтвердили.
describe("lot photo removal", () => {
  const lot = uuidToToken(existingLot);
  const withPhotos = (
    count: number,
    photo?: () => LotPhotoResult | undefined,
  ) => {
    const auction = fakeAuction({
      lots: [scheduled],
      ...(photo === undefined ? {} : { photo }),
    });
    auction.seedPhotos(existingLot, count);
    return auction;
  };

  it("removes the second of three photos after the confirmation over a restart", async () => {
    const auction = withPhotos(3);
    const [, second] = auction.photos.get(existingLot) ?? [];
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(`v1:lot:form:${lot}`));
    expect(last(calls).text).toContain("Фото: 3");
    await next((history) => press(dataOf(last(history), "🖼 Фото")));
    const screen = last(calls);
    expect(plain(screen)).toBe(
      "Фото лота\n<i>Кружка с совой</i>\n\nФото: 3 из 10. Первое — обложка: оно открывает карточку и стоит на экране зала.",
    );
    expect(labels(screen)).toEqual([
      ["Добавить фото"],
      ["🗑 Убрать фото 1"],
      ["🗑 Убрать фото 2"],
      ["🗑 Убрать фото 3"],
      ["‹ Изменить лот"],
    ]);

    await next((history) => press(dataOf(last(history), "🗑 Убрать фото 2")));
    const confirm = last(calls);
    expect(plain(confirm)).toBe(
      [
        "Убрать фото?",
        "Кружка с совой",
        "Фото 2 из 3. Участники больше не увидят его в карточке лота. Вернуть его можно, только прислав фото заново.",
      ].join("\n\n"),
    );
    expect(labels(confirm)).toEqual([["✔️ Да, убрать фото", "✖️ Нет"]]);
    expect(auction.commands).toEqual([]);

    await next((history) => press(dataOf(last(history), "✔️ Да, убрать фото")));
    expect(auction.commands).toEqual([
      {
        method: "removeLotPhoto",
        args: { lotId: existingLot, photoId: second?.photoId },
      },
    ]);
    const outcome = last(calls);
    expect(plain(outcome)).toBe(
      ["Фото убрано", "Кружка с совой", "Фото у лота: 2 из 10."].join("\n\n"),
    );
    expect(labels(outcome)).toEqual([["Фото лота"], ["‹ Лот"]]);
    expect(
      auction.photos.get(existingLot)?.map((photo) => photo.photoId),
    ).not.toContain(second?.photoId);
  });

  it("removes nothing more when the confirmed photo is already gone", async () => {
    const auction = withPhotos(2);
    const [first] = auction.photos.get(existingLot) ?? [];
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:rm:${lot}:1`));
    const confirm = last(calls);
    // Пока подтверждение висело, это фото уже убрали.
    auction.photos.set(
      existingLot,
      (auction.photos.get(existingLot) ?? []).slice(1),
    );
    auction.resync(existingLot);
    await bot.handleUpdate(press(dataOf(confirm, "✔️ Да, убрать фото")));

    expect(first).toBeDefined();
    expect(auction.commands).toEqual([]);
    expect(plain(last(calls))).toContain("Фото у лота: 1 из 10.");
  });

  it("removes the only cover of an Auction without the list by a card edit", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          card: {
            title: "Кружка с совой",
            description: "Ручная роспись.",
            image: { version: "img-old" },
          },
        },
      ],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:ry:${lot}:${fingerprint("img-old")}`));

    expect(auction.commands).toEqual([
      {
        method: "editLotCard",
        args: {
          lotId: existingLot,
          title: "Кружка с совой",
          description: "Ручная роспись.",
          removeImage: true,
        },
      },
    ]);
    expect(plain(last(calls))).toContain("У лота нет фото.");
  });

  it("refuses to open the photos of a sold lot with the sold-lot frame, also to an old removal button", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          status: { kind: "sold", winnerId: existingLot, price: rub(90_000) },
        },
      ],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    for (const data of [
      `v1:lot:ph:${lot}`,
      `v1:lot:rm:${lot}`,
      `v1:lot:rm:${lot}:1`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(plain(last(calls))).toBe(
        "Лот продан. Название, описание и фото больше не меняются.",
      );
    }
    expect(auction.commands).toEqual([]);
  });

  it("returns to the photo screen when the administrator declines the removal", async () => {
    const auction = withPhotos(1);
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:rm:${lot}:1`));
    expect(plain(last(calls))).toContain(
      "Фото 1 из 1. Участники увидят карточку лота без фото.",
    );
    await bot.handleUpdate(press(dataOf(last(calls), "✖️ Нет")));

    expect(plain(last(calls)).split("\n")[0]).toBe("Фото лота");
    expect(auction.commands).toEqual([]);
  });

  it("offers no removal under the photo question", async () => {
    const auction = withPhotos(2);
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:ask:${lot}:image`));

    expect(labels(question(calls).payload)).toEqual([["Отмена"]]);
  });

  it("shows the closed-card frame of the form when Auction refuses the removal", async () => {
    const auction = withPhotos(1, () => ({ kind: "card-closed" }));
    const [first] = auction.photos.get(existingLot) ?? [];
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ry:${lot}:${fingerprint(first?.photoId ?? "")}`),
    );

    const refusal = last(calls);
    expect(plain(refusal)).toBe(
      "Лот закрыт. Название, описание и фото больше не меняются.",
    );
    expect(labels(refusal)).toEqual([["‹ Лот"]]);
    expect(records.every((record) => record.level !== "error")).toBe(true);
  });
});

// Лот глазами участника (PER-512): карточка той же вёрсткой и с тем же фото,
// что у участника, без кнопок ставки, с пометкой и возвратом в форму.
describe("lot preview", () => {
  const lot = uuidToToken(existingLot);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const mark = "Предпросмотр: так лот видят участники.";
  const trading: LotView = {
    ...scheduled,
    card: {
      title: "Кружка с совой",
      description: "Ручная роспись.\n\nОбъём 300 мл.",
      image: { version: "img-1" },
    },
    proxyEnabled: true,
    nextPrice: rub(60_000),
    status: {
      kind: "trading",
      currentPrice: rub(50_000),
      phase: "online",
      deadline: "2026-10-27T00:00:00Z",
    },
  };

  type Card = {
    text?: string;
    rich_message?: {
      html?: string;
      media?: { id: string; media: { media: unknown } }[];
    };
    reply_markup?: {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
  };
  const lastCard = (calls: readonly RecordedCall[]) =>
    calls.at(-1)?.payload as Card;

  it.each(["rich", "plain"] as const)(
    "shows the administrator the card a member sees, marked and without a way to bid (%s)",
    async (presentation) => {
      const auction = fakeAuction({ lots: [trading] });
      auction.images.set(existingLot, { content: jpeg, version: "img-1" });
      const member = harness("member", auction, [], { presentation });
      await member.bot.init();
      await member.bot.handleUpdate(press(lotData(existingLot)));
      const card = lastCard(member.calls);
      // Карточка участника на этом лоте предлагает ставку.
      expect(JSON.stringify(card.reply_markup)).toContain("v1:auc:");

      const admin = harness("admin", auction, [], { presentation });
      await admin.bot.init();
      await admin.bot.handleUpdate(press(`v1:lot:form:${lot}`));
      await admin.bot.handleUpdate(
        press(dataOf(last(admin.calls), "Глазами участника")),
      );
      const preview = lastCard(admin.calls);

      if (presentation === "rich") {
        expect(preview.rich_message?.html).toBe(
          `${card.rich_message?.html}<p>${mark}</p>`,
        );
        expect(card.rich_message?.media?.[0]?.media.media).toBeInstanceOf(
          InputFile,
        );
        expect(preview.rich_message?.media?.[0]?.media.media).toEqual(
          card.rich_message?.media?.[0]?.media.media,
        );
      } else {
        expect(preview.text).toBe(`${card.text}\n\n${mark}`);
      }
      // Ни ставки, ни других кнопок аукциона: только возврат в форму.
      expect(preview.reply_markup?.inline_keyboard).toEqual([
        [{ text: "‹ Изменить лот", callback_data: `v1:lot:form:${lot}` }],
      ]);
      expect(auction.commands).toEqual([]);
    },
  );

  it("returns from the preview to the form of the lot", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:view:${lot}`));
    const preview = last(calls);
    expect(preview.text).toContain("<b>Кружка с совой</b>");
    expect(preview.text?.endsWith(mark)).toBe(true);
    expect(labels(preview)).toEqual([["‹ Изменить лот"]]);

    await bot.handleUpdate(press(dataOf(preview, "‹ Изменить лот")));
    expect(last(calls).text).toContain("<b>Изменить лот</b>");
  });
});

// Цепочка нового лота (PER-618, решение владельца 14 октября 2026 года): после
// названия форма сама спрашивает цену, способ шага, шаг и фото по порядку, а
// итог — «Лот готов». Шаг цепочки лежит в кнопке вопроса и экрана выбора
// способа, поэтому цепочка переживает рестарт посреди.
describe("new lot chain", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const photo = {
    photo: [{ file_id: "large", file_unique_id: "l", width: 800, height: 800 }],
  };
  const photoPrompt =
    "Пришли фото лота ответом на это сообщение — одно или альбомом. Их увидят участники на карточке лота, первое — обложка. Нет фото под рукой — «Пропустить», их можно добавить потом.";
  const readyText = [
    "<b>Лот готов</b>",
    "<b>Ваза</b>",
    "Описание — по желанию: его добавляет «Изменить лот».",
  ].join("\n\n");

  // Каждый шаг ведёт новый бот: память процесса между шагами не доживает.
  function restarting(auction: ReturnType<typeof fakeAuction>) {
    const calls: RecordedCall[] = [];
    const telegram = fakeTelegramFiles({ large: jpeg });
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls, { telegram });
      await bot.init();
      await bot.handleUpdate(update(calls));
    };
    return { calls, next };
  }

  async function titled(
    next: (update: (history: RecordedCall[]) => Update) => Promise<void>,
    auction: ReturnType<typeof fakeAuction>,
  ): Promise<string> {
    await next(() => press(`v1:lot:new:${auctionToken}`));
    await next((history) => answer(history, "Ваза"));
    return [...auction.lots.keys()][0] ?? "";
  }

  it("asks the price, the step and the photo in turn over restarts and ends with the lot ready", async () => {
    const auction = fakeAuction();
    const { calls, next } = restarting(auction);
    const lotId = await titled(next, auction);
    const lot = uuidToToken(lotId);

    expect(dataOf(question(calls).payload, "Отмена")).toBe(`v1:q:cp:${lot}:42`);
    await next((history) => answer(history, "1 500"));

    // Способ шага — тот же экран, кнопки несут цену и признак цепочки.
    const mode = last(calls);
    expect(labels(mode)).toEqual([
      ["Один шаг", "По порогам"],
      ["‹ Изменить лот"],
    ]);
    expect(dataOf(mode, "По порогам")).toBe(`v1:lot:sm:${lot}:1500:tiered:c`);
    await next((history) => press(dataOf(last(history), "По порогам")));
    const step = question(calls).payload;
    expect(dataOf(step, "Отмена")).toBe(`v1:q:cy:${lot}:1500:42`);
    expect(step.text).toContain("Пороги шага — строками");

    await next((history) => answer(history, "0 — 100\n5000 — 250"));
    expect(auction.commands.at(-1)).toMatchObject({
      method: "scheduleLot",
      args: {
        startingPrice: rub(150_000),
        stepPolicy: {
          kind: "tiered",
          tiers: [
            { lowerBound: rub(0), step: rub(10_000) },
            { lowerBound: rub(500_000), step: rub(25_000) },
          ],
        },
      },
    });

    // Условия сохранены — сразу вопрос о фото, без экрана исхода.
    const asked = question(calls).payload;
    expect(asked.text).toBe(["Цена и шаг сохранены.", photoPrompt].join("\n"));
    expect(labels(asked)).toEqual([["Пропустить"], ["Отмена"]]);
    expect(dataOf(asked, "Пропустить")).toBe(`v1:lot:skip:${lot}`);
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ci:${lot}:42`);

    await next((history) => reply(history, photo));
    const ready = last(calls);
    expect(ready.text).toBe(readyText);
    expect(labels(ready)).toEqual([["Изменить лот"], ["‹ Лот"]]);
    expect(dataOf(ready, "‹ Лот")).toBe(lotData(lotId));
    expect(auction.photos.get(lotId)).toHaveLength(1);
  });

  it("skips the photo with a button that removes the question and ends with the lot ready", async () => {
    const auction = fakeAuction();
    const { calls, next } = restarting(auction);
    await titled(next, auction);
    await next((history) => answer(history, "700"));
    await next((history) => press(dataOf(last(history), "Один шаг")));
    await next((history) => answer(history, "50"));
    const asked = question(calls).payload;

    await next(() => press(dataOf(asked, "Пропустить")));

    // Вопрос удалён, как под «Отменой», а итог пришёл новым сообщением.
    expect(calls.map((call) => call.method)).toContain("deleteMessage");
    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(last(calls).text).toBe(readyText);
    expect(auction.methods()).not.toContain("editLotCard");
  });

  it("returns to the lot form when a question in the middle of the chain is cancelled", async () => {
    const auction = fakeAuction();
    const { calls, next } = restarting(auction);
    await titled(next, auction);
    await next((history) => answer(history, "700"));
    await next((history) => press(dataOf(last(history), "Один шаг")));

    await next((history) => press(dataOf(question(history).payload, "Отмена")));

    expect(last(calls).text).toContain("<b>Изменить лот</b>");
    expect(last(calls).text).toContain("Стартовая цена: не задана");
    expect(auction.methods()).toEqual(["createLotCard", "addLot"]);
  });

  it("keeps the chain when a price of the chain is refused and asked again", async () => {
    const auction = fakeAuction();
    const { calls, next } = restarting(auction);
    const lot = uuidToToken(await titled(next, auction));
    await next((history) => answer(history, "дорого"));

    const refusal = last(calls);
    expect(dataOf(refusal, "Ввести заново")).toBe(`v1:lot:ask:${lot}:price:c`);
    await next(() => press(dataOf(refusal, "Ввести заново")));
    // Повтор — вопрос цепочки без строки о добавленном лоте.
    const again = question(calls).payload;
    expect(again.text).toBe(
      "Стартовая цена в рублях, целым числом. Например: 1500",
    );
    expect(dataOf(again, "Отмена")).toBe(`v1:q:cp:${lot}:42`);
    await next((history) => answer(history, "700"));
    expect(dataOf(last(calls), "Один шаг")).toBe(
      `v1:lot:sm:${lot}:700:single:c`,
    );
  });

  it("refuses the step of the chain once trading froze the terms, as outside the chain", async () => {
    const auction = fakeAuction();
    const { calls, next } = restarting(auction);
    const lotId = await titled(next, auction);
    await next((history) => answer(history, "700"));
    const mode = last(calls);
    const lot = auction.lots.get(lotId);
    if (lot === undefined) throw new Error("lot expected");
    auction.lots.set(lotId, {
      ...lot,
      status: { kind: "trading", currentPrice: rub(70_000), phase: "online" },
    });

    await next(() => press(dataOf(mode, "Один шаг")));

    expect(plain(last(calls))).toBe(
      "Торги уже начались. Цену и шаг лота изменить нельзя.",
    );
    expect(auction.methods()).not.toContain("scheduleLot");
  });

  it("does not chain a price or a photo asked from the form", async () => {
    const auction = fakeAuction({ lots: [scheduled] });
    const { calls, next } = restarting(auction);
    const lot = uuidToToken(existingLot);

    await next(() => press(`v1:lot:ask:${lot}:image`));
    expect(labels(question(calls).payload)).toEqual([["Отмена"]]);
    await next(() => press(`v1:lot:ask:${lot}:price`));
    await next((history) => answer(history, "700"));
    expect(dataOf(last(calls), "Один шаг")).toBe(`v1:lot:sm:${lot}:700:single`);
    await next((history) => press(dataOf(last(history), "Один шаг")));
    await next((history) => answer(history, "50"));
    expect(last(calls).text).toBe(
      ["<b>Цена и шаг сохранены</b>", "<b>Кружка с совой</b>"].join("\n\n"),
    );
  });
});

// Копии лота, правка всего сета и удаление лота (PER-716). Форма читает пульт
// аукциона: реестр открыт до онлайн-недели, а сет копий — обычный сет
// (ADR-073). Бот между шагами пересоздаётся: всё, что нужно следующему шагу,
// едет в кнопке.
describe("lot copies, set edits and removal", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
  const version = createHash("sha256").update(jpeg).digest("hex");
  const photo = {
    photo: [
      { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
    ],
  };
  const setLots = [
    "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b01",
    "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b02",
    "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b03",
  ] as const;
  const vaseSet: LotSet = {
    lotSetId: "0198f2a4-7c1e-7d3a-9b21-0000000005e7",
    name: "Ваза",
    lotIds: [...setLots],
  };
  const vase = (lotId: string, index: number): LotView => ({
    lotId,
    auctionId,
    version: 2,
    card: { title: `Ваза | ${index + 1} из 3`, description: "Синяя." },
    proxyEnabled: false,
    fixedStep: rub(10_000),
    status: { kind: "scheduled", startingPrice: rub(50_000) },
  });

  // Бот заново на каждый шаг — над тем же Auction и той же историей чата.
  function steps(
    auction: ReturnType<typeof fakeAuction>,
    telegram = fakeTelegramFiles(),
  ) {
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls, { telegram });
      await bot.init();
      await bot.handleUpdate(update(calls));
    };
    return { calls, next };
  }

  const cardOf = (auction: ReturnType<typeof fakeAuction>, lotId: string) =>
    auction.lots.get(lotId)?.card;

  it("copies a lot without a set into seven lots with one card, price and step, numbered and gathered into a set", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          card: {
            title: "Кружка с совой",
            description: "Ручная роспись.",
            image: { version },
          },
        },
      ],
      console: {},
    });
    auction.images.set(existingLot, { content: jpeg, version });
    const { calls, next } = steps(auction);

    await next(() => press(`v1:lot:form:${uuidToToken(existingLot)}`));
    const form = last(calls);
    expect(labels(form).slice(-3)).toEqual([
      ["Копировать"],
      ["🗑 Удалить лот"],
      ["‹ Лот"],
    ]);
    await next(() => press(dataOf(form, "Копировать")));
    const asked = question(calls).payload;
    expect(asked.text).toContain("Целое число от 2 до 20");
    expect(dataOf(asked, "Отмена")).toBe(
      `v1:q:lc:${uuidToToken(existingLot)}:42`,
    );
    await next((history) => answer(history, "7"));

    const inSet = [...auction.sets.values()];
    expect(inSet).toHaveLength(1);
    const [set] = inSet;
    if (set === undefined) throw new Error("no set");
    expect(set.name).toBe("Кружка с совой");
    expect(set.lotIds).toHaveLength(7);
    expect(set.lotIds[0]).toBe(existingLot);
    expect(new Set(set.lotIds).size).toBe(7);
    set.lotIds.forEach((lotId, index) => {
      expect(auction.registry.has(lotId)).toBe(true);
      const lot = auction.lots.get(lotId);
      // Копия получает фото командой фото (PER-721), а у исходного лота
      // остаётся его обложка.
      expect(lot?.card).toEqual({
        title: `Кружка с совой | ${index + 1} из 7`,
        description: "Ручная роспись.",
        image: { version },
        ...(index === 0
          ? {}
          : { photos: [{ photoId: lotPhotoIdOf(lotId, jpeg), version }] }),
      });
      expect(lot?.status).toEqual({
        kind: "scheduled",
        startingPrice: rub(50_000),
      });
      expect(lot?.fixedStep).toEqual(rub(10_000));
    });
    const outcome = last(calls);
    expect(plain(outcome)).toContain("Лоты скопированы");
    expect(plain(outcome)).toContain(
      "от «Кружка с совой | 1 из 7» до «Кружка с совой | 7 из 7»",
    );
    expect(labels(outcome)).toEqual([["Изменить лот"], ["‹ Лоты"]]);

    // Тот же ответ ещё раз — повтор: ни лотов, ни сета второй раз.
    const before = auction.commands.length;
    await next((history) => answer(history, "7"));
    expect(
      auction.commands
        .slice(before)
        .filter((command) =>
          ["createLotCard", "addLot", "saveLotSet"].includes(command.method),
        ),
    ).toEqual([]);
    expect(auction.registry.size).toBe(7);
  });

  it("removes the extra copies of an earlier answer when the count is answered again smaller", async () => {
    const auction = fakeAuction({ lots: [scheduled], console: {} });
    const { next } = steps(auction);

    await next(() => press(`v1:lot:cp:${uuidToToken(existingLot)}`));
    await next((history) => answer(history, "5"));
    expect(auction.registry.size).toBe(5);
    // Прошлый ответ оборвался до сета: его нет, а копии остались.
    auction.sets.clear();
    await next((history) => answer(history, "3"));

    expect(auction.registry.size).toBe(3);
    const [set] = [...auction.sets.values()];
    expect(set?.lotIds).toHaveLength(3);
    expect(
      set?.lotIds.map((lotId) => auction.lots.get(lotId)?.card?.title),
    ).toEqual([
      "Кружка с совой | 1 из 3",
      "Кружка с совой | 2 из 3",
      "Кружка с совой | 3 из 3",
    ]);
    expect(
      auction.methods().filter((method) => method === "removeLot"),
    ).toHaveLength(2);
  });

  it("asks the count again when it is not a whole number from 2 to 20", async () => {
    const auction = fakeAuction({ lots: [scheduled], console: {} });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:cp:${uuidToToken(existingLot)}`));
    for (const wrong of ["1", "21", "семь"]) {
      await bot.handleUpdate(answer(calls, wrong));
      await reasked(bot, calls, "Нужно целое число от 2 до 20.");
    }
    expect(auction.methods()).toEqual([]);
  });

  it("refuses to copy a lot that is already in a set, naming the set", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:lot:form:${uuidToToken(setLots[0])}`));
    expect(labels(last(calls)).flat()).not.toContain("Копировать");
    expect(last(calls).text).toContain("Сет: Ваза, лотов: 3");
    await bot.handleUpdate(press(`v1:lot:cp:${uuidToToken(setLots[0])}`));
    expect(plain(last(calls))).toContain(
      "Лот уже в сете «Ваза». Копии заводятся только у лота вне сета.",
    );
    expect(auction.methods()).toEqual([]);
  });

  it("asks whether to change one lot or the whole set and renames every lot of the set by its place", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    const { calls, next } = steps(auction);

    await next(() => press(`v1:lot:form:${uuidToToken(setLots[1])}`));
    await next(() => press(dataOf(last(calls), "🔖 Название")));
    const scope = last(calls);
    expect(plain(scope).split("\n")[0]).toBe("Какие лоты изменить?");
    expect(labels(scope)).toEqual([
      ["Только этот лот", "Все лоты сета (3)"],
      ["‹ Изменить лот"],
    ]);
    await next(() => press(dataOf(scope, "Все лоты сета (3)")));
    const asked = question(calls).payload;
    expect(asked.text).toContain(
      "Новое название получат все лоты сета (3), номер «| N из M» бот допишет сам.",
    );
    expect(dataOf(asked, "Отмена")).toBe(
      `v1:q:st:${uuidToToken(setLots[1])}:42`,
    );
    await next((history) => answer(history, "Кувшин"));

    expect(setLots.map((lotId) => cardOf(auction, lotId)?.title)).toEqual([
      "Кувшин | 1 из 3",
      "Кувшин | 2 из 3",
      "Кувшин | 3 из 3",
    ]);
    const outcome = last(calls);
    expect(plain(outcome).split("\n")[0]).toBe("Применено к 3 из 3");
    expect(labels(outcome)).toEqual([["Изменить лот"], ["‹ Лот"]]);
  });

  it("changes the description, the photo, the price and the step of every lot of the set, and of one lot on «Только этот лот»", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    const { calls, next } = steps(auction, fakeTelegramFiles({ large: jpeg }));
    const token = uuidToToken(setLots[0]);

    await next(() => press(`v1:lot:ask:${token}:description:s`));
    await next((history) => answer(history, "Синяя, без сколов."));
    expect(setLots.map((lotId) => cardOf(auction, lotId)?.description)).toEqual(
      ["Синяя, без сколов.", "Синяя, без сколов.", "Синяя, без сколов."],
    );

    await next(() => press(`v1:lot:ask:${token}:image:s`));
    expect(dataOf(question(calls).payload, "Отмена")).toBe(
      `v1:q:si:${token}:42`,
    );
    await next((history) => reply(history, photo));
    expect(setLots.map((lotId) => cardOf(auction, lotId)?.image)).toEqual([
      { version },
      { version },
      { version },
    ]);
    expect(plain(last(calls)).split("\n")[0]).toBe("Применено к 3 из 3");

    await next(() => press(`v1:lot:ask:${token}:price:s`));
    await next((history) => answer(history, "700"));
    const mode = last(calls);
    expect(dataOf(mode, "Один шаг")).toBe(`v1:lot:sm:${token}:700:single:s`);
    await next(() => press(dataOf(mode, "Один шаг")));
    await next((history) => answer(history, "50"));
    for (const lotId of setLots) {
      expect(auction.lots.get(lotId)?.status).toEqual({
        kind: "scheduled",
        startingPrice: rub(70_000),
      });
      expect(auction.lots.get(lotId)?.fixedStep).toEqual(rub(5_000));
    }
    expect(plain(last(calls)).split("\n")[0]).toBe("Применено к 3 из 3");

    // «Только этот лот» — правка одного лота, как вне сета.
    await next(() => press(`v1:lot:sc:${token}:description`));
    await next(() => press(dataOf(last(calls), "Только этот лот")));
    const before = auction.commands.length;
    await next((history) => answer(history, "Только первая."));
    expect(auction.commands.slice(before)).toEqual([
      {
        method: "editLotCard",
        args: {
          lotId: setLots[0],
          title: "Ваза | 1 из 3",
          description: "Только первая.",
        },
      },
    ]);
    expect(plain(last(calls)).split("\n")[0]).toBe("Изменение сохранено");
  });

  it("names the lots Auction refused and applies the edit to them on «Повторить для оставшихся»", async () => {
    let closed = true;
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
      edit: (card) =>
        closed && card.lotId === setLots[2]
          ? { kind: "card-closed" }
          : undefined,
    });
    const { calls, next } = steps(auction);

    await next(() =>
      press(`v1:lot:ask:${uuidToToken(setLots[0])}:description:s`),
    );
    await next((history) => answer(history, "Синяя ваза."));

    const outcome = last(calls);
    expect(plain(outcome)).toBe(
      [
        "Применено к 2 из 3",
        "Ваза | 1 из 3",
        "Не применено: «Ваза | 3 из 3» — лот закрыт.",
      ].join("\n\n"),
    );
    expect(labels(outcome)).toEqual([
      ["Повторить для оставшихся"],
      ["Изменить лот"],
      ["‹ Лот"],
    ]);

    closed = false;
    const before = auction.commands.length;
    await next(() => press(dataOf(outcome, "Повторить для оставшихся")));
    // Повтор правит только лот, где значения ещё нет.
    expect(auction.commands.slice(before)).toEqual([
      {
        method: "editLotCard",
        args: {
          lotId: setLots[2],
          title: "Ваза | 3 из 3",
          description: "Синяя ваза.",
        },
      },
    ]);
    expect(plain(last(calls)).split("\n")[0]).toBe("Применено к 3 из 3");
  });

  it("asks the scope before adding a photo to a lot of the set and removes photos one lot at a time", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    auction.seedPhotos(setLots[0], 2);
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const token = uuidToToken(setLots[0]);

    await bot.handleUpdate(press(`v1:lot:ph:${token}`));
    const screen = last(calls);
    expect(dataOf(screen, "Добавить фото")).toBe(`v1:lot:sc:${token}:image`);
    expect(dataOf(screen, "🗑 Убрать фото 1")).toBe(`v1:lot:rm:${token}:1`);
    await bot.handleUpdate(press(dataOf(screen, "Добавить фото")));
    expect(plain(last(calls))).toContain("в конец их фото");
    expect(dataOf(last(calls), "Все лоты сета (3)")).toBe(
      `v1:lot:ask:${token}:image:s`,
    );
    // Под вопросом о фото снятия нет: фото убирают на экране «Фото лота».
    await bot.handleUpdate(press(`v1:lot:ask:${token}:image:s`));
    expect(labels(question(calls).payload)).toEqual([["Отмена"]]);
  });

  it("adds the photo to the end of every lot of the set, names the lot at the photo limit and retries it", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    auction.seedPhotos(setLots[0], 1);
    auction.seedPhotos(setLots[2], 10);
    const { calls, next } = steps(auction, fakeTelegramFiles({ large: jpeg }));
    const token = uuidToToken(setLots[0]);
    const versions = (lotId: string) =>
      auction.photos.get(lotId)?.map((each) => each.version) ?? [];

    await next(() => press(`v1:lot:ask:${token}:image:s`));
    await next((history) => reply(history, photo));
    expect(versions(setLots[0])).toEqual(["img-1", version]);
    expect(versions(setLots[1])).toEqual([version]);
    expect(versions(setLots[2])).toHaveLength(10);
    const outcome = last(calls);
    expect(plain(outcome)).toBe(
      [
        "Применено к 2 из 3",
        "Ваза | 1 из 3",
        "Не применено: «Ваза | 3 из 3» — у лота предел фото.",
      ].join("\n\n"),
    );

    // Место освободилось: повтор добавляет то же фото только оставшемуся.
    auction.photos.set(
      setLots[2],
      auction.photos.get(setLots[2])?.slice(1) ?? [],
    );
    auction.resync(setLots[2]);
    const before = auction.commands.length;
    await next(() => press(dataOf(outcome, "Повторить для оставшихся")));
    expect(auction.commands.slice(before)).toEqual([
      {
        method: "addLotPhoto",
        args: {
          lotId: setLots[2],
          photoId: lotPhotoIdOf(setLots[2], jpeg),
          image: jpeg,
        },
      },
    ]);
    expect(versions(setLots[2]).at(-1)).toBe(version);
    expect(plain(last(calls)).split("\n")[0]).toBe("Применено к 3 из 3");
  });

  it("retries the photo the set edit spread, not the last photo of the lot", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    const other = new Uint8Array([0xff, 0xd8, 9]);
    const sha = (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex");
    // У исходного лота фото A уже есть, за ним — B.
    auction.photos.set(setLots[0], [
      { photoId: lotPhotoIdOf(setLots[0], jpeg), content: jpeg, version },
      {
        photoId: lotPhotoIdOf(setLots[0], other),
        content: other,
        version: sha(other),
      },
    ]);
    auction.resync(setLots[0]);
    auction.seedPhotos(setLots[2], 10);
    const { calls, next } = steps(auction, fakeTelegramFiles({ large: jpeg }));
    const token = uuidToToken(setLots[0]);

    await next(() => press(`v1:lot:ask:${token}:image:s`));
    await next((history) => reply(history, photo));
    const outcome = last(calls);
    expect(plain(outcome).split("\n")[0]).toBe("Применено к 2 из 3");

    auction.photos.set(
      setLots[2],
      auction.photos.get(setLots[2])?.slice(1) ?? [],
    );
    auction.resync(setLots[2]);
    await next(() => press(dataOf(outcome, "Повторить для оставшихся")));
    expect(auction.photos.get(setLots[2])?.at(-1)?.version).toBe(version);
    expect(
      auction.photos
        .get(setLots[2])
        ?.some((each) => each.version === sha(other)),
    ).toBe(false);
  });

  it("keeps the partial outcome of one album photo when a later photo of the album reaches every lot", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    auction.seedPhotos(setLots[2], 10);
    const second = new Uint8Array([0xff, 0xd8, 2]);
    const telegram = fakeTelegramFiles({ a1: jpeg, a2: second });
    const { bot, calls } = harness("admin", auction, [], { telegram });
    await bot.init();
    const token = uuidToToken(setLots[0]);
    await bot.handleUpdate(press(`v1:lot:ask:${token}:image:s`));
    const asked = question(calls);

    for (const [index, file] of ["a1", "a2"].entries()) {
      // Место у третьего лота освобождается ко второму снимку.
      if (index === 1) {
        auction.photos.set(
          setLots[2],
          auction.photos.get(setLots[2])?.slice(1) ?? [],
        );
        auction.resync(setLots[2]);
      }
      const update = reply(calls, {
        photo: [
          { file_id: file, file_unique_id: file, width: 1280, height: 1280 },
        ],
        media_group_id: "album-set",
      });
      (
        update.message as { reply_to_message: { message_id: number } }
      ).reply_to_message.message_id = asked.messageId;
      await bot.handleUpdate(update);
    }

    const outcomes = calls.filter((call) =>
      ((call.payload as Sent).text ?? "").includes("Применено к"),
    );
    // Исход с непрошедшим лотом остаётся своим сообщением с «Повторить».
    expect(outcomes.map((call) => call.method)).toEqual([
      "sendMessage",
      "sendMessage",
    ]);
    expect(labels(outcomes[0]?.payload as Sent).flat()).toContain(
      "Повторить для оставшихся",
    );
    expect(plain(outcomes[1]?.payload as Sent).split("\n")[0]).toBe(
      "Применено к 3 из 3",
    );
  });

  it("copies every photo of the lot into each copy in the same order", async () => {
    const auction = fakeAuction({
      lots: [
        {
          ...scheduled,
          card: { title: "Кружка с совой", description: "Ручная роспись." },
        },
      ],
      console: {},
    });
    const gallery = [1, 2, 3].map((n) => new Uint8Array([0xff, 0xd8, n]));
    auction.photos.set(
      existingLot,
      gallery.map((content, index) => ({
        photoId: `0198f2a4-7c1e-7d3a-9b21-0000000000a${index}`,
        content,
        version: createHash("sha256").update(content).digest("hex"),
      })),
    );
    auction.resync(existingLot);
    const { next } = steps(auction);

    await next(() => press(`v1:lot:cp:${uuidToToken(existingLot)}`));
    await next((history) => answer(history, "3"));
    const [set] = [...auction.sets.values()];
    if (set === undefined) throw new Error("no set");
    for (const lotId of set.lotIds.slice(1)) {
      expect(auction.photos.get(lotId)?.map((each) => each.content)).toEqual(
        gallery,
      );
    }

    // Повтор ответа фото второй раз не шлёт.
    const before = auction.commands.length;
    await next((history) => answer(history, "3"));
    expect(
      auction.commands.slice(before).map((each) => each.method),
    ).not.toContain("addLotPhoto");
  });

  it("names at most five refused lots with short titles and counts the rest", async () => {
    const long = "Очень длинное название лота ".repeat(10).trim();
    const lotIds = Array.from(
      { length: 8 },
      (_, index) => `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1c0${index}`,
    );
    const auction = fakeAuction({
      lots: lotIds.map((lotId, index) => ({
        ...vase(lotId, index),
        card: { title: `${long} | ${index + 1} из 8`, description: "Синяя." },
      })),
      console: {
        sets: [{ lotSetId: vaseSet.lotSetId, name: "Ваза", lotIds }],
      },
      edit: (card) =>
        card.lotId === lotIds[0] ? undefined : { kind: "card-closed" },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:lot:ask:${uuidToToken(lotIds[0] ?? "")}:description:s`),
    );
    await bot.handleUpdate(answer(calls, "Синяя ваза."));

    const text = plain(last(calls));
    expect(text.split("\n")[0]).toBe("Применено к 1 из 8");
    expect(text.match(/ — лот закрыт/g)).toHaveLength(5);
    expect(text).toContain("; и ещё 2.");
    expect(text.length).toBeLessThan(1500);
  });

  it("removes a lot after the confirmation over a restart, out of the feed and the set, and renumbers the rest on a set rename", async () => {
    const auction = fakeAuction({
      lots: setLots.map(vase),
      console: { sets: [vaseSet] },
    });
    const { calls, next } = steps(auction);

    await next(() => press(`v1:lot:form:${uuidToToken(setLots[1])}`));
    await next(() => press(dataOf(last(calls), "🗑 Удалить лот")));
    const confirm = last(calls);
    expect(plain(confirm).split("\n")[0]).toBe("Удалить лот?");
    expect(labels(confirm)).toEqual([["✔️ Да, удалить лот", "✖️ Нет"]]);
    await next(() => press(dataOf(confirm, "✔️ Да, удалить лот")));

    expect(auction.commands.at(-1)).toMatchObject({
      method: "removeLot",
      args: { auctionId, lotId: setLots[1] },
    });
    const outcome = last(calls);
    expect(plain(outcome).split("\n")[0]).toBe("Лот удалён");
    expect(labels(outcome)).toEqual([["‹ Лоты"]]);
    expect(auction.registry.has(setLots[1])).toBe(false);
    expect(auction.sets.get(vaseSet.lotSetId)?.lotIds).toEqual([
      setLots[0],
      setLots[2],
    ]);
    const feed = await auction.port
      .screenPorts({})
      .auction.listAuctionLots({ auctionId } as never);
    expect(feed.lots.map((lot) => lot.lotId)).toEqual([setLots[0], setLots[2]]);

    await next(() => press(`v1:lot:ask:${uuidToToken(setLots[2])}:title:s`));
    await next((history) => answer(history, "Ваза"));
    expect(cardOf(auction, setLots[0])?.title).toBe("Ваза | 1 из 2");
    expect(cardOf(auction, setLots[2])?.title).toBe("Ваза | 2 из 2");
  });

  it("shows neither copies nor removal once the online week is open and answers forged presses with the refusal of the form", async () => {
    const auction = fakeAuction({
      lots: [scheduled],
      console: { status: "prebidding" },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    const token = uuidToToken(existingLot);

    await bot.handleUpdate(press(`v1:lot:form:${token}`));
    const form = labels(last(calls)).flat();
    expect(form).not.toContain("Копировать");
    expect(form).not.toContain("🗑 Удалить лот");

    await bot.handleUpdate(press(`v1:lot:dy:${token}`));
    expect(auction.methods()).toEqual(["removeLot"]);
    expect(plain(last(calls))).toContain(
      "Торги уже начались. Удалить лот из аукциона нельзя.",
    );
    await bot.handleUpdate(press(`v1:lot:cp:${token}`));
    expect(plain(last(calls))).toContain(
      "Торги уже начались. Добавить лот в этот аукцион нельзя.",
    );
    await bot.handleUpdate(press(`v1:lot:dl:${token}`));
    expect(plain(last(calls))).toContain(
      "Торги уже начались. Удалить лот из аукциона нельзя.",
    );
    expect(auction.methods()).toEqual(["removeLot"]);
  });
});
