import { randomUUID } from "node:crypto";
import { Bot, type Context, GrammyError, HttpError, InputFile } from "grammy";
import type { InputRichMessage, Message, UserFromGetMe } from "grammy/types";
import {
  isAuctionQuestion,
  type LotImagePort,
  type Viewer,
} from "../../auction-ui/index.js";
import type { PortsFactory } from "./clients.js";
import type { Presentation, TelegramEnvironment } from "./config.js";
import { isTraceCallback, parseTraceCallback } from "./delivery/message.js";
import {
  type AuctionEntryScreen,
  type RenderedScreen,
  renderEntryScreen,
  retryLabel,
} from "./entry-screen.js";
import { entryCallback, type FaqContent } from "./faq.js";
import type { LogFields, Logger } from "./logging.js";
import {
  createPhotoCache,
  type ImageKey,
  type PhotoCache,
} from "./photo-cache.js";
import {
  createQuestionMemory,
  type QuestionMemory,
} from "./question-memory.js";
import {
  type RouteOutcome,
  routeAuctionCallback,
  routeAuctionReply,
  routeAuctionStart,
} from "./route.js";
import { screenMark } from "./screen-catalog.js";
import { sourceCodeOf } from "./start-payload.js";
import { startWaiting } from "./waiting.js";

export type BotOptions = {
  token: string;
  environment: TelegramEnvironment;
  // Форма карточки лота; по умолчанию `rich` (ADR-034, дополнение).
  presentation?: Presentation;
  ports: PortsFactory;
  logger: Logger;
  faq?: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  timeZone: string;
  photos?: PhotoCache;
  // Открытые вопросы чатов; по умолчанию своя память процесса.
  questions?: QuestionMemory;
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
      ...(options.presentation === undefined
        ? {}
        : { presentation: options.presentation }),
      ...(options.faq === undefined ? {} : { faq: options.faq }),
    });
  const photos = options.photos ?? createPhotoCache();
  const questions = options.questions ?? createQuestionMemory();

  bot.use((ctx, next) => {
    ctx.requestId = randomUUID();
    ctx.startedAt = process.hrtime.bigint();
    return next();
  });

  // Только личный чат: в группе бот аукциона молчит.
  const direct = bot.chatType("private");

  // Команда отвечает новым сообщением с экраном (дизайн-код, «Доставка»).
  // Бюджет действия у неё тот же, что у нажатия («Ожидание»).
  const answerCommand = async (
    ctx: UpdateContext,
    input: {
      operation: "start" | "faq";
      route: (ports: ReturnType<PortsFactory>) => Promise<RouteOutcome>;
    },
  ) => {
    const { operation } = input;
    const waiting = startWaiting(ctx);
    waiting.begin();
    try {
      const ports = options.ports(ctx.requestId, waiting.deadlineAt);
      const outcome = await input.route(ports);
      // Команда бросает открытые вопросы чата (дизайн-код, «Вопросы»).
      await dropQuestions(ctx, questions);
      await deliver(ctx, {
        screen: render(outcome.screen),
        photos,
        image: ports.image,
        viewer: outcome.viewer,
        logger,
      });
      log({ logger, ctx, outcome, operation });
    } finally {
      await waiting.finish();
    }
  };

  // `/menu` из кнопки меню клиента — тот же вход, что `/start` без кода канала
  // (PER-472): допущенному — меню или FAQ, остальным — их кадр входа.
  direct.command("menu", (ctx) =>
    answerCommand(ctx, {
      operation: "start",
      route: (ports) =>
        routeAuctionStart({
          ports,
          user: userOf(ctx.from),
          firstName: ctx.from.first_name,
        }),
    }),
  );

  direct.command("start", (ctx) => {
    const sourceCode = sourceCodeOf(ctx.match);
    return answerCommand(ctx, {
      operation: "start",
      route: (ports) =>
        routeAuctionStart({
          ...(sourceCode === undefined ? {} : { sourceCode }),
          ports,
          user: userOf(ctx.from),
          firstName: ctx.from.first_name,
        }),
    });
  });

  // FAQ с любого места бота, не возвращаясь по дереву (дизайн-код, «Дерево
  // бота аукциона»). Доступ проверяется так же, как у кнопки «Правила и FAQ»:
  // ожидающий допуска и заблокированный получают свой кадр. Заявку команда не
  // ставит — вход остаётся за `/start`.
  direct.command("faq", (ctx) =>
    answerCommand(ctx, {
      operation: "faq",
      route: (ports) =>
        routeAuctionCallback({
          ports,
          user: userOf(ctx.from),
          firstName: ctx.from.first_name,
          data: entryCallback("faq"),
        }),
    }),
  );

  direct.on("callback_query:data", async (ctx) => {
    // Ответ на нажатие уходит вместе с результатом, а не до похода к
    // сервисам: пока его нет, клиент сам крутит индикатор на кнопке
    // (дизайн-код, «Ожидание»). Отвечает первый видимый вызов Bot API, сторож
    // либо `finish` ниже.
    const waiting = startWaiting(ctx);
    let outcome: RouteOutcome | undefined;
    // Кнопка под уведомлением: внутри обычная кнопка лота, а экран уходит
    // новым сообщением, и уведомление остаётся в истории целым (дизайн-код,
    // «Доставка»).
    const traced = parseTraceCallback(ctx.callbackQuery.data);
    const data = traced ?? ctx.callbackQuery.data;
    // «Отмена» под вопросом: вопрос удаляется, экран приходит новым
    // сообщением (дизайн-код, «Доставка»).
    const cancelling = isAuctionQuestion(data);
    try {
      const ports = options.ports(ctx.requestId, waiting.deadlineAt);
      waiting.begin();
      outcome = await routeAuctionCallback({
        ports,
        user: userOf(ctx.from),
        firstName: ctx.from.first_name,
        data,
      });
      const screen = render(outcome.screen);
      const delivery = {
        screen,
        photos,
        image: ports.image,
        viewer: outcome.viewer,
        logger,
      };
      const pressed = ctx.callbackQuery.message?.message_id;
      if (cancelling && pressed !== undefined) {
        questions.forget(ctx.chat.id, pressed);
        const deleted = await deleteMessage(ctx, pressed);
        // Удалить не дали — вопрос правится в экран на месте.
        await deliver(ctx, { ...delivery, keepCurrent: deleted });
      } else {
        await dropQuestions(ctx, questions);
        if (screen.asks === true) {
          // Повтор под кадром отказа задал вопрос: кадр своё отслужил и
          // удаляется, иначе он остался бы в чате без кнопок. Удалить не дали
          // — с него, как с любого экрана над вопросом, снимается клавиатура.
          const spent =
            pressed !== undefined &&
            pressedLabel(ctx) === retryLabel &&
            (await deleteMessage(ctx, pressed));
          await ask(ctx, questions, screen, {
            clearPressed: !spent && !isTraceCallback(ctx.callbackQuery.data),
          });
        } else {
          await deliver(ctx, {
            ...delivery,
            keepCurrent: isTraceCallback(ctx.callbackQuery.data),
          });
        }
      }
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

  // Ответ на вопрос листа ставки (PER-317): reply на сообщение бота, шаг —
  // `callback_data` его «Отмены». Прочие сообщения бот оставляет без ответа.
  direct.on("message", async (ctx) => {
    const replied = ctx.message.reply_to_message;
    if (replied === undefined || replied.from?.id !== ctx.me.id) return;
    const data = replied.reply_markup?.inline_keyboard[0]?.[0];
    if (
      data === undefined ||
      !("callback_data" in data) ||
      !isAuctionQuestion(data.callback_data)
    ) {
      return;
    }
    const waiting = startWaiting(ctx);
    waiting.begin();
    let outcome: RouteOutcome | undefined;
    try {
      const ports = options.ports(ctx.requestId, waiting.deadlineAt);
      const { text } = ctx.message;
      outcome = await routeAuctionReply({
        ports,
        user: userOf(ctx.from),
        data: data.callback_data,
        ...(text === undefined ? {} : { text }),
      });
      const screen = render(outcome.screen);
      if (screen.asks === true) {
        // Отвергнутый ответ: новый вопрос с причиной, прежний — после него.
        await ask(ctx, questions, screen, { replaces: replied.message_id });
      } else {
        // Результат — одним новым сообщением, у вопроса снимается «Отмена».
        // После сбоя сервиса вопрос остаётся открытым: тот же ответ можно
        // прислать ещё раз.
        await deliver(ctx, {
          screen,
          photos,
          image: ports.image,
          viewer: outcome.viewer,
          logger,
          keepCurrent: true,
        });
        if (outcome.failure === undefined) {
          questions.forget(ctx.chat.id, replied.message_id);
          await closeQuestion(ctx, replied.message_id);
        }
      }
    } finally {
      await waiting.finish();
      if (outcome !== undefined) {
        log({ logger, ctx, outcome, operation: "reply" });
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
  operation: "start" | "faq" | "callback" | "reply";
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
  const inline_keyboard = screen.keyboard.map((r) => [...r]);
  return {
    ...screenMark(screen.id),
    // Разметку rich-сообщения несёт его `html`, а не `parse_mode`.
    ...(screen.format === "html" ? { parse_mode: "HTML" as const } : {}),
    // Вопрос открывает режим ответа сам, а «Отмена» под ним даёт выход
    // (дизайн-код, «Вопросы»).
    reply_markup:
      screen.asks === true
        ? { force_reply: true as const, inline_keyboard }
        : { inline_keyboard },
  };
}

// Подпись нажатой кнопки: клавиатура сообщения приходит в самом нажатии, и
// хранить её боту не нужно.
function pressedLabel(ctx: UpdateContext): string | undefined {
  const message = ctx.callbackQuery?.message;
  const data = ctx.callbackQuery?.data;
  if (message === undefined || !("reply_markup" in message)) return undefined;
  return message.reply_markup?.inline_keyboard
    .flat()
    .find(
      (button) => "callback_data" in button && button.callback_data === data,
    )?.text;
}

function userOf(from: { id: number; username?: string }) {
  return {
    telegramUserId: from.id,
    ...(from.username === undefined ? {} : { telegramUsername: from.username }),
  };
}

// Вопрос приходит новым сообщением, экран над ним теряет клавиатуру: в чате
// остаётся одно место, где действовать. Заданный заново вопрос сначала
// уходит, и только потом закрывается прежний.
async function ask(
  ctx: UpdateContext,
  questions: QuestionMemory,
  screen: RenderedScreen,
  how: { clearPressed?: boolean; replaces?: number },
): Promise<void> {
  if (how.clearPressed === true && ctx.callbackQuery?.message !== undefined) {
    await clearKeyboard(ctx);
  }
  const chatId = ctx.chat?.id;
  const sent = await ctx.reply(screen.text, markupOf(screen));
  if (chatId === undefined) return;
  questions.remember(chatId, sent.message_id);
  if (how.replaces !== undefined) {
    questions.forget(chatId, how.replaces);
    await closeQuestion(ctx, how.replaces);
  }
}

// Брошенный вопрос удаляется: человек нажал кнопку в другом сообщении или
// отправил команду. Вопрос, заданный до рестарта, память не знает — он
// остаётся в чате и по-прежнему принимает ответ.
async function dropQuestions(
  ctx: UpdateContext,
  questions: QuestionMemory,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  for (const messageId of questions.takeAll(chatId)) {
    await deleteMessage(ctx, messageId);
  }
}

// Вопрос, на который ответили, больше не ждёт: «Отмена» под ним снимается,
// как в боте хаба (дизайн-код, «Вопросы»).
async function closeQuestion(
  ctx: UpdateContext,
  messageId: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await ctx.api
    .editMessageReplyMarkup(chatId, messageId, {
      reply_markup: { inline_keyboard: [] },
    })
    .catch(() => undefined);
}

/** Удаляет сообщение бота; `false` — Telegram удалить не дал. */
async function deleteMessage(
  ctx: UpdateContext,
  messageId: number,
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  try {
    await ctx.api.deleteMessage(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}

// Фото rich-карточки: из кэша `file_id` или байтами из Auction. Не удалось —
// карточка уходит без фото: изображение украшает экран, а не держит его.
type Photo =
  | { kind: "cached"; key: ImageKey; fileId: string }
  | { kind: "upload"; key: ImageKey; file: InputFile };

// Идентификатор фото внутри rich-сообщения: им `<img>` ссылается на `media`.
const photoId = "lot";

// Содержимое rich-сообщения: фото — последним блоком под текстом карточки.
export function richMessageOf(
  screen: RenderedScreen,
  photo: Photo | undefined,
): InputRichMessage {
  if (photo === undefined) return { html: screen.text };
  return {
    html: `${screen.text}<img src="tg://photo?id=${photoId}"/>`,
    media: [
      {
        id: photoId,
        media: {
          type: "photo",
          media: photo.kind === "cached" ? photo.fileId : photo.file,
        },
      },
    ],
  };
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
  const cached = input.photos.get(key);
  // Эту версию Telegram уже не принял: до рестарта она не загружается.
  if (cached?.kind === "none") return undefined;
  if (cached !== undefined)
    return { kind: "cached", key, fileId: cached.fileId };
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

// Доставка экрана правилами края (дизайн-код, «Доставка» и «Показ фото лота»).
// Нажатие правит своё сообщение: текст ленты и rich-карточка лота делят одно
// сообщение и правятся друг в друга, удаления при смене вида нет. Новым
// сообщением экран приходит, только когда править нечего: под нажатием
// сообщение-фото от прежней версии бота, или Telegram правку не принял.
async function deliver(
  ctx: UpdateContext,
  input: {
    screen: RenderedScreen;
    photos: PhotoCache;
    image: LotImagePort;
    viewer: Viewer | undefined;
    logger: Logger;
    // Нажатие под следом: сообщение, под которым нажали, не правится и не
    // удаляется — экран уходит новым.
    keepCurrent?: boolean;
  },
): Promise<void> {
  const { screen } = input;
  const markup = markupOf(screen);
  // След под уведомлением остаётся целым: его не правят и клавиатуру не
  // снимают.
  const current =
    input.keepCurrent === true ? undefined : ctx.callbackQuery?.message;
  // Текст у сообщения с файлом Telegram править не даёт: под ним экран
  // приходит новым сообщением, а само оно остаётся в чате без клавиатуры —
  // действовать можно только на новом экране.
  const legacy =
    current !== undefined && ("photo" in current || "document" in current);
  let editable = current !== undefined && !legacy;
  const leave = async () => {
    if (legacy) await clearKeyboard(ctx);
  };
  if (screen.format !== "rich") {
    try {
      if (editable) {
        await ctx.editMessageText(screen.text, markup);
        return;
      }
    } catch (cause) {
      if (!(cause instanceof GrammyError)) throw cause;
      if (notModified(cause.description)) return;
      if (!notEditable(cause.description)) throw cause;
    }
    await ctx.reply(screen.text, markup);
    await leave();
    return;
  }
  let photo = await photoFor({ ...input, requestId: ctx.requestId });
  // Новое сообщение после отказа правки загрузку не повторяет.
  let mayUpload = true;
  // Загруженная версия, на которой Telegram отказал.
  let rejected: ImageKey | undefined;
  for (;;) {
    try {
      const rich = richMessageOf(screen, photo);
      const sent = editable
        ? await ctx.editMessageText(rich, markup)
        : await ctx.replyWithRichMessage(rich, markup);
      remember({ ...input, requestId: ctx.requestId, photo, sent });
      // Без фото карточка дошла — значит, отказ был в самом изображении, а не
      // в лимите, правах или разметке: только тогда версия помечается.
      if (rejected !== undefined) input.photos.refuse(rejected);
      await leave();
      return;
    } catch (cause) {
      if (photo?.kind === "upload" && cause instanceof HttpError) {
        // Обрыв соединения: Telegram мог вызов и не получить. Отметки нет,
        // следующее открытие лота загрузит изображение снова.
        input.logger.warn("lot image upload interrupted", {
          request_id: ctx.requestId,
          error: messageOf(cause),
        });
        // Новое сообщение не повторяется: если Telegram его принял, повтор
        // прислал бы второе. Правка того же сообщения дубля не даёт.
        if (!editable) throw cause;
        photo = undefined;
        continue;
      }
      if (!(cause instanceof GrammyError)) throw cause;
      if (notModified(cause.description)) return;
      if (editable && notEditable(cause.description)) {
        // Сообщение не редактируется — экран уходит новым сообщением по
        // `file_id` из кэша либо без фото.
        editable = false;
        mayUpload = false;
        if (photo?.kind === "upload") photo = undefined;
        continue;
      }
      if (photo?.kind === "cached" && rejectedFile(cause.description)) {
        // Telegram больше не знает этот `file_id`: запись вытесняется, и
        // повтор идёт загрузкой байтов один раз.
        input.photos.delete(photo.key);
        photo = mayUpload
          ? await photoFor({ ...input, requestId: ctx.requestId })
          : undefined;
        mayUpload = false;
        continue;
      }
      if (photo !== undefined) {
        // Telegram отказал вызову с фото — файл велик, не картинка или не
        // обработался. Сообщение после отказа прежнее, и карточка уходит той
        // же правкой без фото; загруженная версия помечается, если правка без
        // фото пройдёт.
        input.logger.warn("lot image rejected by Telegram", {
          request_id: ctx.requestId,
          error: cause.description,
        });
        if (photo.kind === "upload") rejected = photo.key;
        photo = undefined;
        continue;
      }
      throw cause;
    }
  }
}

async function clearKeyboard(ctx: UpdateContext): Promise<void> {
  await ctx
    .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
    .catch(() => undefined);
}

// `file_id` наибольшего размера из ответа Telegram ложится в кэш под версией
// загруженных байтов. Ответ правки — тоже сообщение, поэтому кэш греется с
// любого показа.
function remember(input: {
  photos: PhotoCache;
  photo: Photo | undefined;
  sent: Message | true;
  logger: Logger;
  requestId: string;
}): void {
  const { photos, photo, sent } = input;
  if (photo?.kind !== "upload" || sent === true) return;
  const fileId = sent.rich_message?.blocks
    .flatMap((block) => (block.type === "photo" ? [block.photo] : []))
    .at(-1)
    ?.at(-1)?.file_id;
  if (fileId !== undefined) {
    photos.set(photo.key, fileId);
    return;
  }
  // Загрузка прошла, а фото в ответе нет: без записи каждый показ грузил бы
  // байты заново, и это должно быть видно.
  input.logger.warn("lot image file_id missing in response", {
    request_id: input.requestId,
  });
}

// Описания отказов Bot API не закреплены контрактом: сравнение без учёта
// регистра и по обоим известным написаниям.
const REJECTED_FILE =
  /wrong (remote )?file identifier|file[_ ]reference|wrong file_id/i;

function rejectedFile(description: string): boolean {
  return REJECTED_FILE.test(description);
}

// Тот же экран после повторного нажатия — не отказ.
function notModified(description: string): boolean {
  return description.includes("message is not modified");
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
