import {
  type AuctionCommand,
  type AuctionQuestion,
  encodeAuctionCallback,
  type PendingCommand,
} from "../../callback-data.js";
import type {
  AuctionPort,
  BidRefusal,
  CommandOutcome,
  DisplayNameChoice,
  DisplayNameRefusal,
  FavoritesPort,
  LotView,
  Money,
  OperationIdPort,
  ProxyExplainerPort,
  ProxyLimitRefusal,
  TelegramUser,
  Viewer,
} from "../../ports.js";
import type {
  AnswerRefusal,
  AuctionButton,
  AuctionScreenBody,
  BidExtension,
  CommandResult,
  FinalBidOutcome,
  ProxyExample,
} from "../../screen.js";
import { parseAmount } from "./amount.js";
import { showLot } from "./open-lot.js";

// Сырые юзкейсы листа ставки (PER-317). Доступ проверил шлюз; здесь — путь от
// кнопки до команды Auction и обратно к карточке.
export type CommandContext = {
  auction: AuctionPort;
  operations: OperationIdPort;
  favorites?: FavoritesPort;
  proxyExplainer?: ProxyExplainerPort;
  viewer: Viewer;
  user: TelegramUser;
};

function readLot(context: CommandContext, lotId: string): Promise<LotView> {
  return context.auction.getLot({ viewer: context.viewer, lotId });
}

const lotCallback = (lotId: string, page: number, atLeastVersion?: number) =>
  encodeAuctionCallback({
    kind: "lot",
    lotId,
    page,
    ...(atLeastVersion === undefined ? {} : { atLeastVersion }),
  });

const titled = (lot: LotView) =>
  lot.card === undefined ? {} : { title: lot.card.title };

// Подтверждение команды. `op_id` рождается здесь, когда экран показывают, и
// едет в «Да»: ключ принадлежит намерению, а не нажатию.
function confirmBody(
  context: CommandContext,
  lot: LotView,
  pending: PendingCommand,
  currentPrice: Money,
  page: number,
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "confirm",
        command: pending.command,
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
        amount: { minorUnits: pending.amount, currency: currentPrice.currency },
        currentPrice,
        ...firstProxyBid(lot, pending),
      },
    ],
    keyboard: [
      [
        {
          action: "confirm.yes",
          callbackData: encodeAuctionCallback({
            kind: "commit",
            command: pending.command,
            lotId: lot.lotId,
            opId: context.operations.newOperationId(),
            amount: pending.amount,
            page,
          }),
        },
        { action: "confirm.no", callbackData: lotCallback(lot.lotId, page) },
      ],
    ],
  };
}

// Подтверждают только то, что предлагает карточка: ставку и лимит в
// онлайн-торгах. Устаревшая кнопка или ответ на вопрос после смены состояния
// получают карточку с отказом без похода в Auction с заведомо мёртвой
// командой: удержанный лот называет цену, остальные — «торги не идут».
//
// Имя спрашивается до подтверждения (PER-595): иначе первую ставку человек
// подтверждал бы дважды — до выбора имени и после. `named` — имя уже известно:
// его только что выбрали.
async function confirmOrRefuse(
  context: CommandContext,
  lot: LotView,
  pending: PendingCommand,
  page: number,
  named = false,
): Promise<AuctionScreenBody> {
  const { status } = lot;
  if (status.kind !== "trading" || status.phase !== "online") {
    return resultBody(lot, page, notOffered(pending.command, lot));
  }
  const refusal =
    pending.command === "bid"
      ? refusedBeforeConfirm(context.viewer, lot, status, pending.amount)
      : undefined;
  if (refusal !== undefined) {
    return resultBody(lot, page, { command: "bid", kind: "refused", refusal });
  }
  if (!named && !(await nameChosen(context, lot, status))) {
    return nameChoiceBody(context, lot, pending, page);
  }
  return confirmBody(context, lot, pending, status.currentPrice, page);
}

// Выбрано ли имя в аукционе лота. Лидер и держатель лимита уже ставили, и
// имя у них есть: Auction за ним не зовут. Отказ чтения имени не прячет
// ставку: подтверждение показывается, а без имени Auction отклонит команду
// отказом `display-name-not-chosen`, и выбор имени придёт после «Да».
async function nameChosen(
  context: CommandContext,
  lot: LotView,
  status: Extract<LotView["status"], { kind: "trading" }>,
): Promise<boolean> {
  if (
    status.leaderId === context.viewer.identityId ||
    lot.viewerProxyLimit !== undefined
  ) {
    return true;
  }
  try {
    const own = await context.auction.getOwnDisplayName({
      viewer: context.viewer,
      auctionId: lot.auctionId,
    });
    return own !== undefined;
  } catch {
    return true;
  }
}

// Отказы, которые снимок лота называет до «Да» (PER-473): лидер не ставит
// против себя, а сумма ниже порога не пройдёт. Auction проверяет то же самое
// на команде — снимок мог устареть, — но человек не видит подтверждения
// ставки, заведомо мёртвой уже по экрану, с которого он её поставил.
function refusedBeforeConfirm(
  viewer: Viewer,
  lot: LotView,
  status: Extract<LotView["status"], { kind: "trading" }>,
  amount: number,
): BidRefusal | undefined {
  if (status.leaderId === viewer.identityId) {
    return { kind: "bidder-is-leader", currentPrice: status.currentPrice };
  }
  if (lot.nextPrice !== undefined && amount < lot.nextPrice.minorUnits) {
    return { kind: "bid-below-minimum", minRequired: lot.nextPrice };
  }
  return undefined;
}

// Ветки одинаковы по форме, но разные по типу: `CommandResult` сужает отказ
// по команде, и TypeScript собирает его только из литерала команды.
function notOffered(command: AuctionCommand, lot: LotView): CommandResult {
  if (command === "bid") {
    return lot.status.kind === "held"
      ? {
          command,
          kind: "refused",
          refusal: {
            kind: "lot-on-hold",
            currentPrice: lot.status.currentPrice,
          },
        }
      : { command, kind: "refused", refusal: { kind: "lot-not-open" } };
  }
  return { command, kind: "refused", refusal: { kind: "lot-not-open" } };
}

export async function confirmCommand(
  context: CommandContext,
  intent: { lotId: string; page: number } & PendingCommand,
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  return confirmOrRefuse(context, lot, intent, intent.page);
}

// Повтор только там, где ответа не было вовсе, — и ровно один, тем же
// `op_id` (RFC-011, П-06). Именованный отказ окончателен и не повторяется.
// Тем же правилом идут команды розыгрыша (`raffle.ts`).
export async function withOneRetry<Outcome extends { kind: string }>(
  call: () => Promise<Outcome>,
): Promise<Outcome> {
  const first = await call();
  return first.kind === "unanswered" ? call() : first;
}

export async function commitCommand(
  context: CommandContext,
  intent: {
    command: AuctionCommand;
    lotId: string;
    opId: string;
    amount: number;
    page: number;
  },
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  // «Да» из устаревшего подтверждения: лот ушёл из онлайн-торгов — в финал,
  // в удержание или к итогу. Ставка финала — лист карточки финала, поэтому
  // команда не уходит, а карточка называет отказ по снимку.
  const { status } = lot;
  if (status.kind !== "trading" || status.phase !== "online") {
    return resultBody(lot, intent.page, notOffered(intent.command, lot));
  }
  const amount: Money = {
    minorUnits: intent.amount,
    currency: status.currentPrice.currency,
  };
  const request = {
    viewer: context.viewer,
    lotId: intent.lotId,
    opId: intent.opId,
  };
  // Отметки читаются параллельно команде, а не до неё: медленный
  // Notifications не задерживает ставку у дедлайна. Ставка кладёт лот в
  // избранное асинхронно, по факту из шины, поэтому чтение, начатое вместе с
  // командой, видит отметки до неё.
  const followed = notFollowedYet(context, intent.lotId);
  const settled = {
    context,
    lot,
    intent,
    amount,
    autoFollowNote: followed,
  };
  return intent.command === "bid"
    ? settle(
        settled,
        await withOneRetry(() =>
          context.auction.placeBid({ ...request, amount }),
        ),
        (refusal) => ({ command: "bid", kind: "refused", refusal }),
      )
    : settle(
        settled,
        await withOneRetry(() =>
          context.auction.setProxyLimit({ ...request, max: amount }),
        ),
        (refusal) => ({ command: "proxy", kind: "refused", refusal }),
      );
}

// Ставка финала одним нажатием (ADR-049, PER-336): сумма кнопки — ожидаемая
// цена, `op_id` рождается на нажатии и повторяется один раз, только если
// ответа не было. Исход — строка на карточке финала, которую ответ и
// показывает: карточка остаётся живой, и после отказа `bid-not-at-next-price`
// её кнопка уже несёт новую цену. Лот вне финала — устаревшая кнопка: карточка
// показывает, где лот, без похода в Auction с мёртвой командой.
export async function placeFinalBid(
  context: CommandContext,
  intent: { lotId: string; amount: number; page: number },
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  const { status } = lot;
  const shown = (shownLot: LotView, finalBid?: FinalBidOutcome) =>
    showLot({
      ...context,
      lot: shownLot,
      page: intent.page,
      ...(finalBid === undefined ? {} : { finalBid }),
    });
  if (status.kind !== "trading" || status.phase !== "live") return shown(lot);
  const amount: Money = {
    minorUnits: intent.amount,
    currency: status.currentPrice.currency,
  };
  const opId = context.operations.newOperationId();
  const outcome = await withOneRetry(() =>
    context.auction.placeBid({
      viewer: context.viewer,
      lotId: intent.lotId,
      amount,
      opId,
    }),
  );
  switch (outcome.kind) {
    case "accepted":
      // Чтение отстаёт от команды: карточка дочитывает лот до версии ответа,
      // иначе принятая ставка стояла бы над прежней ценой.
      return shown(
        await context.auction.getLot({
          viewer: context.viewer,
          lotId: intent.lotId,
          ...(outcome.lotVersion > 0
            ? { atLeastVersion: outcome.lotVersion }
            : {}),
        }),
        { kind: "accepted", amount },
      );
    case "unanswered":
      return shown(await readLot(context, intent.lotId), { kind: "unknown" });
    case "refused": {
      const { refusal } = outcome;
      if (refusal.kind === "display-name-not-chosen") {
        return nameChoiceBody(
          context,
          lot,
          { command: "bid", amount: intent.amount },
          intent.page,
        );
      }
      return shown(
        atLeastExpected(await readLot(context, intent.lotId), refusal),
        { kind: "refused", refusal },
      );
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Отказ называет цену, которую лот ждёт сейчас, а чтение может отставать от
// команды, которая её подняла: кнопка карточки не должна предлагать цену ниже
// названной в отказе — нажатие на неё снова получило бы отказ.
function atLeastExpected(lot: LotView, refusal: BidRefusal): LotView {
  if (refusal.kind !== "bid-not-at-next-price") return lot;
  const { expected } = refusal;
  if (
    lot.nextPrice !== undefined &&
    lot.nextPrice.currency === expected.currency &&
    lot.nextPrice.minorUnits >= expected.minorUnits
  ) {
    return lot;
  }
  return { ...lot, nextPrice: expected };
}

// Ответ Auction на команду — экран. Принятая, отказ и неизвестный исход — свои
// экраны с «К лоту»: лот они не перечитывают, карточку перечитывает кнопка.
// У принятой кнопка несёт версию из ответа, и карточка дочитывает лот до неё:
// чтение Auction отстаёт от команды (PER-470).
// Имя не выбрано — экран выбора имени, а не отказ.
async function settle<Refusal extends BidRefusal | ProxyLimitRefusal>(
  settled: {
    context: CommandContext;
    lot: LotView;
    intent: {
      command: AuctionCommand;
      lotId: string;
      amount: number;
      page: number;
    };
    amount: Money;
    autoFollowNote: Promise<boolean>;
  },
  outcome: CommandOutcome<Refusal>,
  refused: (refusal: Refusal) => CommandResult,
): Promise<AuctionScreenBody> {
  const { context, lot, intent, amount } = settled;
  switch (outcome.kind) {
    case "accepted": {
      if (intent.command === "proxy") markExplainerSeen(context);
      const extension = await extensionAfter(context, lot, outcome.lotVersion);
      return acceptedBody(lot, intent, amount, outcome.lotVersion, {
        favorites: await settled.autoFollowNote,
        ...(extension === undefined ? {} : { extension }),
      });
    }
    case "unanswered":
      // Команда могла пройти: что вышло, покажет карточка за «К лоту» — она
      // читает лот заново.
      return resultBody(lot, intent.page, {
        command: intent.command,
        kind: "unknown",
      });
    case "refused":
      if (outcome.refusal.kind === "display-name-not-chosen") {
        return nameChoiceBody(
          context,
          lot,
          { command: intent.command, amount: intent.amount },
          intent.page,
        );
      }
      return resultBody(lot, intent.page, refused(outcome.refusal));
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Подсказку об избранном (ADR-063) экран показывает, только если лота там ещё
// не было (PER-631, №108): иначе она повторялась бы на каждой ставке. Отметки
// читаются до команды — после неё Notifications кладёт лот туда сам. Сбой
// чтения подсказку оставляет: лишняя строка дешевле молчания о том, что
// ставка меняет избранное.
async function notFollowedYet(
  context: CommandContext,
  lotId: string,
): Promise<boolean> {
  if (context.favorites === undefined) return false;
  try {
    const followed = await context.favorites.listFollowedLots(context.viewer);
    return !followed.includes(lotId);
  } catch {
    return true;
  }
}

// Продление анти-снайпом после принятой команды (PER-631, №107). Продления
// кончились до ставки — дедлайн уже не сдвинется, и перечитывать нечего.
// Иначе лот перечитывается до версии из ответа: выросло число продлений —
// ставка продлила торги. Часов в дереве нет, поэтому «ставка в окне» решает
// не время, а счётчик продлений Auction. Сбой чтения строку убирает, а экран
// принятой ставки не роняет: ставка уже принята.
async function extensionAfter(
  context: CommandContext,
  before: LotView,
  lotVersion: number,
): Promise<BidExtension | undefined> {
  const { status, antiSnipe } = before;
  if (
    status.kind !== "trading" ||
    status.deadline === undefined ||
    status.extensionsUsed === undefined ||
    antiSnipe === undefined ||
    antiSnipe.maxExtensions <= 0
  ) {
    return undefined;
  }
  if (status.extensionsUsed >= antiSnipe.maxExtensions) {
    return { kind: "exhausted", deadline: status.deadline };
  }
  let after: LotView;
  try {
    after = await context.auction.getLot({
      viewer: context.viewer,
      lotId: before.lotId,
      ...(lotVersion > 0 ? { atLeastVersion: lotVersion } : {}),
    });
  } catch {
    return undefined;
  }
  const next = after.status;
  if (
    next.kind !== "trading" ||
    next.deadline === undefined ||
    next.extensionsUsed === undefined ||
    next.extensionsUsed <= status.extensionsUsed
  ) {
    return undefined;
  }
  return {
    kind: "extended",
    deadline: next.deadline,
    used: next.extensionsUsed,
    max: antiSnipe.maxExtensions,
    windowSeconds: antiSnipe.windowSeconds,
  };
}

// Версия 0 — Auction её не назвал: кнопка прежняя, карточка читает один раз.
// Выходов два (PER-595): к лоту и к ленте его аукциона. `favorites` — лота
// не было в избранном, и экран говорит, что ставка кладёт лот туда сама
// (ADR-063); `extension` — что анти-снайп сделал с дедлайном.
function acceptedBody(
  lot: LotView,
  intent: { command: AuctionCommand; lotId: string; page: number },
  amount: Money,
  lotVersion: number,
  notes: { favorites: boolean; extension?: BidExtension },
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "accepted",
        command: intent.command,
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
        amount,
        ...(notes.favorites ? { favorites: true } : {}),
        ...(notes.extension === undefined
          ? {}
          : { extension: notes.extension }),
      },
    ],
    keyboard: [
      [
        {
          action: "accepted.lot",
          callbackData: lotCallback(
            lot.lotId,
            intent.page,
            lotVersion > 0 ? lotVersion : undefined,
          ),
        },
      ],
      [
        {
          action: "accepted.feed",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: lot.auctionId,
            page: intent.page,
          }),
        },
      ],
    ],
  };
}

// Отказ команды или неизвестный исход — свой экран с «К лоту» (PER-472).
function resultBody(
  lot: LotView,
  page: number,
  result: CommandResult,
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "result",
        result,
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
      },
    ],
    keyboard: [
      [{ action: "result.lot", callbackData: lotCallback(lot.lotId, page) }],
    ],
  };
}

// Непринятый ответ или отказ имени — свой экран (PER-472). `retry` задаёт
// вопрос заново; его нет, когда повтор ничего не изменит.
function answerRefusedBody(
  lot: LotView,
  page: number,
  refusal: AnswerRefusal,
  retry: AuctionButton | undefined,
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "answer-refused",
        refusal,
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
      },
    ],
    keyboard: [
      ...(retry === undefined ? [] : [[retry]]),
      [{ action: "result.lot", callbackData: lotCallback(lot.lotId, page) }],
    ],
  };
}

function askAgain(intent: QuestionIntent): AuctionButton {
  return {
    action: "answer.retry",
    callbackData: encodeAuctionCallback({
      kind: "ask",
      question: intent.question,
      lotId: intent.lotId,
      page: intent.page,
      ...(intent.pending === undefined ? {} : { pending: intent.pending }),
    }),
  };
}

// Первая ставка в аукционе: имя видно всем, и выбрать его нужно до команды
// (ADR-059). Ник предлагается, только если он есть в update.
function nameChoiceBody(
  context: CommandContext,
  lot: LotView,
  pending: PendingCommand,
  page: number,
): AuctionScreenBody {
  const username = context.user.telegramUsername;
  return {
    blocks: [
      {
        kind: "name-choice",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
        ...(username === undefined || username === "" ? {} : { username }),
      },
    ],
    keyboard: [
      ...(username === undefined || username === ""
        ? []
        : [
            [
              {
                action: "name.username" as const,
                callbackData: encodeAuctionCallback({
                  kind: "username",
                  lotId: lot.lotId,
                  page,
                  pending,
                }),
              },
            ],
          ]),
      [
        {
          action: "name.alias",
          callbackData: encodeAuctionCallback({
            kind: "ask",
            question: "alias",
            lotId: lot.lotId,
            page,
            pending,
          }),
        },
      ],
      [{ action: "name.back", callbackData: lotCallback(lot.lotId, page) }],
    ],
  };
}

type QuestionIntent = {
  question: AuctionQuestion;
  lotId: string;
  page: number;
  pending?: PendingCommand;
  // «Как это работает» (PER-517): пояснение автоставки без оглядки на отметку.
  explain?: boolean;
};

// Первая принятая автоставка снимает пояснение с вопроса лимита. Экран
// принятой команды отметку не ждёт: зависший Notifications его бы задержал.
// Отказ команду не отменяет: пояснение покажется ещё раз, а адаптер о сбое
// уже сообщил.
function markExplainerSeen(context: CommandContext): void {
  context.proxyExplainer?.markSeen(context.viewer).catch(() => {
    // Принятая автоставка важнее отметки.
  });
}

// Пояснение показывается до первой принятой автоставки. Не знает бот, видел
// ли его человек, — нет Notifications или он не ответил, — пояснение
// показывается: лишний абзац дешевле перепутанных цены и лимита.
async function explainerShown(
  context: CommandContext,
  intent: QuestionIntent,
): Promise<boolean> {
  if (intent.question !== "proxy") return false;
  if (intent.explain === true || context.proxyExplainer === undefined) {
    return true;
  }
  try {
    return !(await context.proxyExplainer.seen(context.viewer));
  } catch {
    return true;
  }
}

// У лота без лидера автоставка сразу ставит порог `nextPrice` — стартовую
// цену (П-01): лимит, равный ей, не «ничего», а первая ставка.
function firstProxyBid(
  lot: LotView,
  pending: PendingCommand,
): { firstBid?: Money } {
  const { status } = lot;
  const firstBid = lot.nextPrice;
  if (
    pending.command !== "proxy" ||
    status.kind !== "trading" ||
    status.leaderId !== undefined ||
    firstBid === undefined ||
    firstBid.minorUnits > pending.amount
  ) {
    return {};
  }
  return { firstBid };
}

// Пример на текущем лоте: цена сейчас, шаг в силе — сниженный окном, если
// оно идёт, — и лимит на три шага выше. Не лидеру автоставка сразу ставит
// порог `nextPrice`, который посчитал Auction; лидеру — ничего. Нет цены,
// шага или, у не лидера, порога — примера нет.
const EXAMPLE_STEPS = 3;

function proxyExample(lot: LotView, viewer: Viewer): ProxyExample | undefined {
  const { status } = lot;
  if (status.kind !== "trading") return undefined;
  const step = lot.activeWindow?.step ?? lot.baseStep ?? lot.fixedStep;
  if (step === undefined || step.minorUnits <= 0) return undefined;
  const { currentPrice } = status;
  if (step.currency !== currentPrice.currency) return undefined;
  const limit = {
    minorUnits: currentPrice.minorUnits + EXAMPLE_STEPS * step.minorUnits,
    currency: currentPrice.currency,
  };
  if (status.leaderId === viewer.identityId) {
    return { currentPrice, step, limit };
  }
  const firstBid = lot.nextPrice;
  if (
    firstBid === undefined ||
    firstBid.currency !== currentPrice.currency ||
    firstBid.minorUnits > limit.minorUnits
  ) {
    return undefined;
  }
  return { currentPrice, step, limit, firstBid };
}

// Вопрос с `force_reply`. Шаг и адресат едут в «Отмене»: ответ вернёт их в
// `reply_to_message`, и вопрос переживёт рестарт процесса.
function questionBody(
  context: CommandContext,
  lot: LotView,
  intent: QuestionIntent,
  explained: boolean,
): AuctionScreenBody {
  const current =
    intent.question === "bid"
      ? lot.nextPrice
      : intent.question === "proxy"
        ? (lot.viewerProxyLimit ?? lot.nextPrice)
        : undefined;
  return {
    blocks: [
      {
        kind: "question",
        question: intent.question,
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
        ...(current === undefined ? {} : { current }),
        ...(intent.question === "proxy" && lot.viewerProxyLimit !== undefined
          ? { currentIsLimit: true }
          : {}),
        ...(explained ? { explainer: explainerOf(lot, context.viewer) } : {}),
      },
    ],
    keyboard: [
      ...(intent.question === "proxy" && !explained
        ? [
            [
              {
                action: "question.explain" as const,
                callbackData: encodeAuctionCallback({
                  kind: "explain",
                  lotId: lot.lotId,
                  page: intent.page,
                }),
              },
            ],
          ]
        : []),
      [
        {
          action: "question.cancel",
          callbackData: encodeAuctionCallback({
            kind: "question",
            question: intent.question,
            lotId: lot.lotId,
            page: intent.page,
            addressee: context.user.telegramUserId,
            ...(intent.pending === undefined
              ? {}
              : { pending: intent.pending }),
          }),
        },
      ],
    ],
  };
}

function explainerOf(lot: LotView, viewer: Viewer): { example?: ProxyExample } {
  const example = proxyExample(lot, viewer);
  return example === undefined ? {} : { example };
}

export async function askQuestion(
  context: CommandContext,
  intent: QuestionIntent,
): Promise<AuctionScreenBody> {
  const [lot, explained] = await Promise.all([
    readLot(context, intent.lotId),
    explainerShown(context, intent),
  ]);
  return questionBody(context, lot, intent, explained);
}

// «Отмена» под вопросом: экран, с которого вопрос задан, — выбор имени у
// псевдонима и карточка у суммы.
export async function cancelQuestion(
  context: CommandContext,
  intent: QuestionIntent,
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  return intent.pending !== undefined && intent.question === "alias"
    ? nameChoiceBody(context, lot, intent.pending, intent.page)
    : showLot({ ...context, lot, page: intent.page });
}

// Ответ на вопрос. Непринятый ответ — экран отказа с «Ввести заново», а не
// исключение: ввод человека — недоверенная строка.
export async function answerQuestion(
  context: CommandContext,
  intent: QuestionIntent,
  text: string | undefined,
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  if (text === undefined) {
    return answerRefusedBody(lot, intent.page, "not-text", askAgain(intent));
  }
  if (intent.question === "alias") {
    if (intent.pending === undefined) {
      return showLot({ ...context, lot, page: intent.page });
    }
    return chooseName(
      context,
      lot,
      { kind: "alias", alias: text },
      intent.pending,
      intent.page,
      (refusal) =>
        answerRefusedBody(
          lot,
          intent.page,
          refusal,
          refusal === "name-frozen" ? undefined : askAgain(intent),
        ),
    );
  }
  const command = intent.question;
  const { status } = lot;
  if (status.kind !== "trading" || status.phase !== "online") {
    return resultBody(lot, intent.page, notOffered(command, lot));
  }
  const amount = parseAmount(text, status.currentPrice.currency);
  if (!amount.ok) {
    return answerRefusedBody(
      lot,
      intent.page,
      amount.refusal,
      askAgain(intent),
    );
  }
  return confirmOrRefuse(
    context,
    lot,
    { command, amount: amount.minorUnits },
    intent.page,
  );
}

export async function chooseUsername(
  context: CommandContext,
  intent: { lotId: string; page: number; pending: PendingCommand },
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  return chooseName(
    context,
    lot,
    { kind: "username", username: context.user.telegramUsername ?? "" },
    intent.pending,
    intent.page,
    // Без ника остаётся псевдоним; имя, которое уже не поменять, повтор не
    // спасёт.
    (refusal) =>
      answerRefusedBody(
        lot,
        intent.page,
        refusal,
        refusal === "name-frozen"
          ? undefined
          : {
              action: "name.alias",
              callbackData: encodeAuctionCallback({
                kind: "ask",
                question: "alias",
                lotId: lot.lotId,
                page: intent.page,
                pending: intent.pending,
              }),
            },
      ),
  );
}

// Выбор имени и переход к отложенной команде: после принятого имени человек
// видит подтверждение с новым `op_id` и жмёт «Да» сам — один раз, потому что
// имя спрошено до подтверждения (PER-595). Имя, которое уже не поменять, уже
// выбрано — ставкой из другого окна, пока висел этот экран: команде оно не
// мешает. В живом финале подтверждения нет (ADR-049): человек возвращается на
// карточку финала и жмёт «Поставить» на цену, которая действует сейчас
// (PER-336).
async function chooseName(
  context: CommandContext,
  lot: LotView,
  choice: DisplayNameChoice,
  pending: PendingCommand,
  page: number,
  refused: (refusal: DisplayNameRefusal) => AuctionScreenBody,
): Promise<AuctionScreenBody> {
  const outcome = await context.auction.chooseDisplayName({
    viewer: context.viewer,
    auctionId: lot.auctionId,
    choice,
  });
  if (outcome.kind === "refused" && outcome.refusal !== "name-frozen") {
    return refused(outcome.refusal);
  }
  if (lot.status.kind === "trading" && lot.status.phase === "live") {
    return showLot({ ...context, lot, page });
  }
  return confirmOrRefuse(context, lot, pending, page, true);
}
