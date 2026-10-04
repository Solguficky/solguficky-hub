import { randomUUID } from "node:crypto";
import type { LotImagePort, Viewer } from "@solguficky/auction-bot-ui";
import { Bot, type Context, GrammyError, InputFile } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import type { PortsFactory } from "./clients.js";
import type { TelegramEnvironment } from "./config.js";
import {
  type AuctionEntryScreen,
  type RenderedScreen,
  renderEntryScreen,
} from "./entry-screen.js";
import type { FaqContent } from "./faq.js";
import type { LogFields, Logger } from "./logging.js";
import {
  createPhotoCache,
  type ImageKey,
  type PhotoCache,
} from "./photo-cache.js";
import {
  type RouteOutcome,
  routeAuctionCallback,
  routeAuctionStart,
} from "./route.js";
import { screenMark } from "./screen-catalog.js";
import { sourceCodeOf } from "./start-payload.js";
import { startWaiting } from "./waiting.js";

export type BotOptions = {
  token: string;
  environment: TelegramEnvironment;
  ports: PortsFactory;
  logger: Logger;
  faq?: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  timeZone: string;
  // Аукцион ленты: есть — пункт меню «Аукционы» открывает его лоты.
  auctionId?: string;
  photos?: PhotoCache;
  // Тесты передают его, чтобы не звать getMe.
  botInfo?: UserFromGetMe;
};

type UpdateContext = Context & { requestId: string; startedAt: bigint };

// Адаптер grammY: Telegram заканчивается здесь. Маршрут и оболочка Telegram
// не знают, бот хаба этот модуль не импортирует (ADR-044).
export function createBot(options: BotOptions): Bot<UpdateContext> {
  const bot = new Bot<UpdateContext>(options.token, {
    client: { environment: options.environment },
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  });
  const { logger } = options;
  const render = (screen: AuctionEntryScreen) =>
    renderEntryScreen(screen, {
      timeZone: options.timeZone,
      ...(options.faq === undefined ? {} : { faq: options.faq }),
    });
  const photos = options.photos ?? createPhotoCache();
  const auction =
    options.auctionId === undefined ? {} : { auctionId: options.auctionId };

  bot.use((ctx, next) => {
    ctx.requestId = randomUUID();
    ctx.startedAt = process.hrtime.bigint();
    return next();
  });

  // Только личный чат: в группе бот аукциона молчит.
  const direct = bot.chatType("private");

  // Бюджет действия у команды тот же, что у нажатия (дизайн-код, «Ожидание»).
  direct.command("start", async (ctx) => {
    const waiting = startWaiting(ctx);
    waiting.begin();
    try {
      const sourceCode = sourceCodeOf(ctx.match);
      const outcome = await routeAuctionStart({
        ...auction,
        ...(sourceCode === undefined ? {} : { sourceCode }),
        ports: options.ports(ctx.requestId, waiting.deadlineAt),
        user: {
          telegramUserId: ctx.from.id,
          ...(ctx.from.username === undefined
            ? {}
            : { telegramUsername: ctx.from.username }),
        },
      });
      const screen = render(outcome.screen);
      await ctx.reply(screen.text, markupOf(screen));
      log({ logger, ctx, outcome, operation: "start" });
    } finally {
      await waiting.finish();
    }
  });

  direct.on("callback_query:data", async (ctx) => {
    // Ответ на нажатие уходит вместе с результатом, а не до похода к
    // сервисам: пока его нет, клиент сам крутит индикатор на кнопке
    // (дизайн-код, «Ожидание»). Отвечает первый видимый вызов Bot API, сторож
    // либо `finish` ниже.
    const waiting = startWaiting(ctx);
    let outcome: RouteOutcome | undefined;
    try {
      const ports = options.ports(ctx.requestId, waiting.deadlineAt);
      waiting.begin();
      outcome = await routeAuctionCallback({
        ...auction,
        ports,
        user: {
          telegramUserId: ctx.from.id,
          ...(ctx.from.username === undefined
            ? {}
            : { telegramUsername: ctx.from.username }),
        },
        data: ctx.callbackQuery.data,
      });
      await deliver(ctx, {
        screen: render(outcome.screen),
        photos,
        image: ports.image,
        viewer: outcome.viewer,
        logger,
      });
    } finally {
      await waiting.finish();
      // Отказ ответа на нажатие доставку не отменяет: он только пишется.
      if (waiting.answerError !== undefined) {
        logger.warn("answerCallbackQuery failed", {
          request_id: ctx.requestId,
          error: waiting.answerError,
        });
      }
      if (outcome !== undefined) {
        log({ logger, ctx, outcome, operation: "callback" });
      }
    }
  });

  bot.catch((failure) => {
    logger.error("update failed", {
      ...frame(failure.ctx, "update"),
      result: "error",
      error_category: "unexpected",
      error: messageOf(failure.error),
    });
  });

  return bot;
}

function frame(ctx: UpdateContext, operation: string): LogFields {
  return {
    operation,
    request_id: ctx.requestId,
    duration_us: Number((process.hrtime.bigint() - ctx.startedAt) / 1000n),
  };
}

// Исход экрана — в поле `screen`; `result` и класс отказа — по logging.md.
function log(input: {
  logger: Logger;
  ctx: UpdateContext;
  outcome: RouteOutcome;
  operation: "start" | "callback";
}): void {
  const { logger, ctx, outcome, operation } = input;
  const fields: LogFields = {
    ...frame(ctx, operation),
    screen: outcome.screen.kind,
    ...(outcome.identityId === undefined
      ? {}
      : { identity_id: outcome.identityId }),
  };
  if (outcome.failure !== undefined) {
    logger.error("update handled", {
      ...fields,
      result: "error",
      error_category: outcome.failure.category,
      error: outcome.failure.message,
      ...(outcome.failure.grpcCode === undefined
        ? {}
        : { grpc_code: outcome.failure.grpcCode }),
    });
    return;
  }
  const category = refusalCategory(outcome.screen);
  if (category === undefined) {
    logger.info("update handled", { ...fields, result: "ok" });
  } else {
    logger.info("update handled", {
      ...fields,
      result: "error",
      error_category: category,
    });
  }
}

function refusalCategory(
  screen: AuctionEntryScreen,
): "authorization" | "invariant" | undefined {
  switch (screen.kind) {
    case "denied":
      return "authorization";
    case "outdated":
      return "invariant";
    default:
      return undefined;
  }
}

// Метка экрана едет в параметрах каждой отправки: по ней линтер test kit
// сверяет экран с каталогом, а клавиатура без метки роняет тест. Тот же
// параметр собирает тест каталога экранов, а не свою копию.
export function markupOf(screen: RenderedScreen) {
  return {
    ...screenMark(screen.id),
    reply_markup: { inline_keyboard: screen.keyboard.map((r) => [...r]) },
  };
}

// Фото для экрана: из кэша `file_id` или байтами из Auction. Не удалось —
// карточка уходит текстом: изображение украшает экран, а не держит его.
type Photo =
  | { kind: "cached"; key: ImageKey; fileId: string }
  | { kind: "upload"; key: ImageKey; file: InputFile };

function mediaOf(photo: Photo): string | InputFile {
  return photo.kind === "cached" ? photo.fileId : photo.file;
}

async function photoFor(input: {
  screen: RenderedScreen;
  photos: PhotoCache;
  image: LotImagePort;
  viewer: Viewer | undefined;
  logger: Logger;
  requestId: string;
}): Promise<Photo | undefined> {
  const key = input.screen.photo;
  if (key === undefined || input.viewer === undefined) return undefined;
  const fileId = input.photos.get(key);
  if (fileId !== undefined) return { kind: "cached", key, fileId };
  try {
    const image = await input.image.getLotImage({
      viewer: input.viewer,
      lotId: key.lotId,
    });
    return {
      kind: "upload",
      // Ключ — версия самих байтов: если изображение сменили между чтением
      // карточки и загрузкой, старое фото не ляжет под новым ключом.
      key: { lotId: key.lotId, version: image.version },
      file: new InputFile(image.content, "lot"),
    };
  } catch (cause) {
    input.logger.warn("lot image unavailable", {
      request_id: input.requestId,
      error: messageOf(cause),
    });
    return undefined;
  }
}

// Доставка экрана правилами края (бриф ботов, «Правила края при отказах
// Telegram»). Текстовое сообщение не превращается в фото и обратно, поэтому
// смена вида — новое сообщение и удаление старого; отказ удаления (сообщение
// старше 48 часов) не мешает: новое уже ушло.
async function deliver(
  ctx: UpdateContext,
  input: {
    screen: RenderedScreen;
    photos: PhotoCache;
    image: LotImagePort;
    viewer: Viewer | undefined;
    logger: Logger;
  },
): Promise<void> {
  let photo = await photoFor({ ...input, requestId: ctx.requestId });
  const { screen } = input;
  const markup = markupOf(screen);
  const current = ctx.callbackQuery?.message;
  const currentIsPhoto = current !== undefined && "photo" in current;
  for (;;) {
    try {
      if (photo === undefined) {
        if (current !== undefined && !currentIsPhoto) {
          await ctx.editMessageText(screen.text, markup);
        } else {
          await ctx.reply(screen.text, markup);
          await dropPrevious(ctx, current);
        }
        return;
      }
      const sent = currentIsPhoto
        ? await ctx.editMessageMedia(
            { type: "photo", media: mediaOf(photo), caption: screen.text },
            markup,
          )
        : await ctx.replyWithPhoto(mediaOf(photo), {
            caption: screen.text,
            ...markup,
          });
      if (!currentIsPhoto) await dropPrevious(ctx, current);
      remember({ photos: input.photos, photo, sent });
      return;
    } catch (cause) {
      if (!(cause instanceof GrammyError)) throw cause;
      // Тот же экран после повторного нажатия — не отказ.
      if (cause.description.includes("message is not modified")) return;
      if (notEditable(cause.description)) {
        // Сообщение не редактируется — ответ уходит новым сообщением.
        if (photo === undefined) {
          await ctx.reply(screen.text, markup);
        } else {
          remember({
            photos: input.photos,
            photo,
            sent: await ctx.replyWithPhoto(mediaOf(photo), {
              caption: screen.text,
              ...markup,
            }),
          });
        }
        return;
      }
      if (photo?.kind === "cached" && rejectedFile(cause.description)) {
        // Telegram больше не знает этот `file_id`: запись вытесняется, и
        // повтор идёт загрузкой байтов один раз.
        input.photos.delete(photo.key);
        photo = await photoFor({ ...input, requestId: ctx.requestId });
        continue;
      }
      if (photo !== undefined) {
        // Telegram не принял само изображение — файл велик, не картинка или
        // не обработался. Карточка уходит текстом, а не пропадает.
        input.logger.warn("lot image rejected by Telegram", {
          request_id: ctx.requestId,
          error: cause.description,
        });
        photo = undefined;
        continue;
      }
      throw cause;
    }
  }
}

async function dropPrevious(
  ctx: UpdateContext,
  current: Message | undefined,
): Promise<void> {
  if (current === undefined) return;
  await ctx.deleteMessage().catch(() => undefined);
}

// `file_id` наибольшего размера из ответа Telegram ложится в кэш под версией
// загруженных байтов.
function remember(input: {
  photos: PhotoCache;
  photo: Photo;
  sent: Message | true;
}): void {
  const { photos, photo, sent } = input;
  if (photo.kind !== "upload" || sent === true) return;
  const fileId = sent.photo?.at(-1)?.file_id;
  if (fileId !== undefined) photos.set(photo.key, fileId);
}

// Описания отказов Bot API не закреплены контрактом: сравнение без учёта
// регистра и по обоим известным написаниям.
const REJECTED_FILE =
  /wrong (remote )?file identifier|file[_ ]reference|wrong file_id/i;

function rejectedFile(description: string): boolean {
  return REJECTED_FILE.test(description);
}

function notEditable(description: string): boolean {
  return (
    description.includes("message can't be edited") ||
    description.includes("message to edit not found")
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
