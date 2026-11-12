import {
  type AuctionCommand,
  type AuctionQuestion,
  encodeAuctionCallback,
  type PendingCommand,
  type PlacedCommand,
} from "../../callback-data.js";
import { FinalBidReadUnavailable } from "../../final-bid-failure.js";
import { readOutbidOrigin } from "../../outbid-origin.js";
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
  offered: Offered,
  page: number,
): AuctionScreenBody {
  const { currentPrice } = offered;
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
        ...(offered.forFinal ? { forFinal: true as const } : {}),
        ...(offered.liveFinal
          ? {
              liveFinal: true as const,
              ...(lot.nextPrice === undefined
                ? {}
                : { nextPrice: lot.nextPrice }),
              ...(offered.leaderId === context.viewer.identityId
                ? { liveFinalLeader: true as const }
                : {}),
            }
          : firstProxyBid({ lot, pending })),
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

// Что лот принимает от бота сейчас: ставку и лимит онлайн-торгов и, у лота,
// который ждёт финала, только лимит (PER-821, ADR-079): он сработает в финале
// по сетке цен. Ставка удержанного лота — отказ `lot-on-hold`.
type Offered = {
  currentPrice: Money;
  leaderId?: string;
  forFinal: boolean;
  liveFinal: boolean;
};

function offeredFor(
  lot: LotView,
  command: AuctionCommand,
): Offered | undefined {
  const { status } = lot;
  if (status.kind === "trading" && status.phase === "online") {
    return {
      currentPrice: status.currentPrice,
      ...(status.leaderId === undefined ? {} : { leaderId: status.leaderId }),
      forFinal: false,
      liveFinal: false,
    };
  }
  if (status.kind === "held" && command === "proxy") {
    return {
      currentPrice: status.currentPrice,
      ...(status.leaderId === undefined ? {} : { leaderId: status.leaderId }),
      forFinal: true,
      liveFinal: false,
    };
  }
  if (
    status.kind === "trading" &&
    status.phase === "live" &&
    command === "proxy"
  ) {
    return {
      currentPrice: status.currentPrice,
      ...(status.leaderId === undefined ? {} : { leaderId: status.leaderId }),
      forFinal: false,
      liveFinal: true,
    };
  }
  return undefined;
}

// Подтверждают только то, что предлагает карточка: ставку и лимит в
// онлайн-торгах и лимит удержанного лота. Устаревшая кнопка или ответ на
// вопрос после смены состояния получают карточку с отказом без похода в
// Auction с заведомо мёртвой командой: удержанный лот называет цену, остальные
// — «торги не идут».
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
  const offered = offeredFor(lot, pending.command);
  if (offered === undefined) {
    return resultBody(lot, page, notOffered(pending.command, lot));
  }
  const refusal =
    pending.command === "bid" && status.kind === "trading"
      ? refusedBeforeConfirm(context.viewer, lot, status, pending.amount)
      : undefined;
  if (refusal !== undefined) {
    return resultBody(lot, page, { command: "bid", kind: "refused", refusal });
  }
  const minimumProxyLimit = minimumProxyLimitOf(lot) ?? offered.currentPrice;
  if (
    (offered.forFinal || offered.liveFinal) &&
    pending.amount < minimumProxyLimit.minorUnits
  ) {
    return resultBody(lot, page, {
      command: "proxy",
      kind: "refused",
      refusal: {
        kind: "proxy-below-current-price",
        minLimit: minimumProxyLimit,
      },
    });
  }
  if (!named && !(await nameChosen(context, lot, offered.leaderId))) {
    return nameChoiceBody(context, lot, pending, page);
  }
  return confirmBody(context, lot, pending, offered, page);
}

// Выбрано ли имя в аукционе лота. Лидер и держатель лимита уже ставили, и
// имя у них есть: Auction за ним не зовут. Отказ чтения имени не прячет
// ставку: подтверждение показывается, а без имени Auction отклонит команду
// отказом `display-name-not-chosen`, и выбор имени придёт после «Да».
async function nameChosen(
  context: CommandContext,
  lot: LotView,
  leaderId: string | undefined,
): Promise<boolean> {
  if (
    leaderId === context.viewer.identityId ||
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
function notOffered(command: PlacedCommand, lot: LotView): CommandResult {
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

// Снять свой лимит (PER-822): подтверждение показывает лимит, который лот
// называет сейчас. Лимита нет — «лимита уже нет», без похода в Auction.
export async function confirmWithdraw(
  context: CommandContext,
  intent: { lotId: string; page: number },
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  const { status, viewerProxyLimit: limit } = lot;
  if (
    limit === undefined ||
    (status.kind !== "trading" && status.kind !== "held")
  ) {
    return resultBody(lot, intent.page, noLimitResult);
  }
  return {
    blocks: [
      {
        kind: "confirm",
        command: "withdraw",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        ...titled(lot),
        amount: limit,
        currentPrice: status.currentPrice,
        ...(status.kind === "held" ? { forFinal: true as const } : {}),
      },
    ],
    keyboard: [
      [
        {
          action: "confirm.yes",
          callbackData: encodeAuctionCallback({
            kind: "commit",
            command: "withdraw",
            lotId: lot.lotId,
            opId: context.operations.newOperationId(),
            amount: limit.minorUnits,
            page: intent.page,
          }),
        },
        {
          action: "confirm.no",
          callbackData: lotCallback(lot.lotId, intent.page),
        },
      ],
    ],
  };
}

const noLimitResult: CommandResult = {
  command: "withdraw",
  kind: "refused",
  refusal: { kind: "no-active-limit" },
};

// «Да» снятия: `op_id` рождён при показе подтверждения, повтор того же «Да»
// несёт тот же ключ, и Auction второй команды не исполняет. Отказ один —
// лимита уже нет — и для человека это исход, а не сбой.
export async function commitWithdraw(
  context: CommandContext,
  intent: { lotId: string; opId: string; amount: number; page: number },
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  // «Да» из устаревшего подтверждения: лимит с тех пор изменился. Снимать
  // другой лимит, чем тот, что человек видел, нельзя — подтверждение
  // показывается заново с нынешним.
  if (
    lot.viewerProxyLimit !== undefined &&
    lot.viewerProxyLimit.minorUnits !== intent.amount
  ) {
    return confirmWithdraw(context, intent);
  }
  const outcome = await withOneRetry(() =>
    context.auction.withdrawProxyLimit({
      viewer: context.viewer,
      lotId: intent.lotId,
      opId: intent.opId,
    }),
  );
  switch (outcome.kind) {
    case "accepted":
      return resultBody(lot, intent.page, {
        command: "withdraw",
        kind: "withdrawn",
      });
    case "refused":
      return resultBody(lot, intent.page, {
        command: "withdraw",
        kind: "refused",
        refusal: outcome.refusal,
      });
    case "unanswered":
      return resultBody(lot, intent.page, {
        command: "withdraw",
        kind: "unknown",
      });
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
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
    command: PlacedCommand;
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
  const offered = offeredFor(lot, intent.command);
  if (offered === undefined) {
    return resultBody(lot, intent.page, notOffered(intent.command, lot));
  }
  const amount: Money = {
    minorUnits: intent.amount,
    currency: offered.currentPrice.currency,
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
  // Лимит удержанного лота события для Notifications не рождает и лот в
  // избранное не кладёт: подсказки об этом на экране нет (PER-821).
  const followed = offered.forFinal
    ? Promise.resolve(false)
    : notFollowedYet(context, intent.lotId);
  const settled = {
    context,
    lot,
    intent,
    amount,
    forFinal: offered.forFinal,
    liveFinal: offered.liveFinal,
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
  let lot: LotView;
  try {
    lot = await readLot(context, intent.lotId);
  } catch (cause) {
    throw new FinalBidReadUnavailable(cause);
  }
  return placeFinalBidOn(context, lot, intent);
}

// Ставка финала по уже прочитанному лоту: и нажатие «Поставить», и выбранное
// после него имя (PER-713) идут одним путём.
async function placeFinalBidOn(
  context: CommandContext,
  lot: LotView,
  intent: { lotId: string; amount: number; page: number },
): Promise<AuctionScreenBody> {
  const { status } = lot;
  const shown = (shownLot: LotView, finalBid?: FinalBidOutcome) =>
    showLot({
      ...context,
      lot: shownLot,
      page: intent.page,
      ...(finalBid === undefined ? {} : { finalBid }),
    });
  if (status.kind === "trading" && status.phase !== "live") return shown(lot);
  if (status.kind !== "trading")
    return shown(lot, { kind: "refused", refusal: { kind: "lot-not-open" } });
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
  // После отправки недоступность чтения не означает отказ ставки. Хотя бы
  // исход команды остаётся видимым на уже прочитанной карточке.
  const reread = async (version?: number) => {
    try {
      return await context.auction.getLot({
        viewer: context.viewer,
        lotId: intent.lotId,
        ...(version === undefined || version <= 0
          ? {}
          : { atLeastVersion: version }),
      });
    } catch {
      return undefined;
    }
  };
  switch (outcome.kind) {
    case "accepted": {
      // Чтение отстаёт от команды: карточка дочитывает лот до версии ответа,
      // иначе принятая ставка стояла бы над прежней ценой.
      const current = await reread(outcome.lotVersion);
      return shown(
        current ?? lot,
        current === undefined
          ? { kind: "accepted-unread", amount }
          : {
              kind: "accepted",
              amount,
              ...(outcome.lotVersion > 0 &&
              (await overtakenOnCommand(
                current,
                context.viewer,
                context.auction,
              ))
                ? { overtaken: true as const }
                : {}),
            },
      );
    }
    case "unanswered":
      return shown((await reread()) ?? lot, { kind: "unknown" });
    case "refused": {
      const { refusal } = outcome;
      if (refusal.kind === "display-name-not-chosen") {
        return nameChoiceBody(
          context,
          lot,
          { command: "bid", amount: intent.amount, final: true },
          intent.page,
        );
      }
      return shown(atLeastExpected((await reread()) ?? lot, refusal), {
        kind: "refused",
        refusal,
      });
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
      command: PlacedCommand;
      lotId: string;
      amount: number;
      page: number;
    };
    amount: Money;
    forFinal: boolean;
    liveFinal: boolean;
    autoFollowNote: Promise<boolean>;
  },
  outcome: CommandOutcome<Refusal>,
  refused: (refusal: Refusal) => CommandResult,
): Promise<AuctionScreenBody> {
  const { context, lot, intent, amount } = settled;
  switch (outcome.kind) {
    case "accepted": {
      if (intent.command === "proxy") markExplainerSeen(context);
      // Лот после команды читается один раз: и продление анти-снайпом, и
      // смена лидера, после которой происхождение ищется в хронологии
      // (PER-840).
      let afterRead: Promise<LotView | undefined> | undefined;
      const readAfter = () => {
        afterRead ??= context.auction
          .getLot({
            viewer: context.viewer,
            lotId: lot.lotId,
            ...(outcome.lotVersion > 0
              ? { atLeastVersion: outcome.lotVersion }
              : {}),
          })
          .catch(() => undefined);
        return afterRead;
      };
      const extension = await extensionAfter(lot, readAfter);
      // Версия 0 — Auction её не назвал: чтение может показать лот до ставки,
      // и «перебила автоставка» было бы ложью.
      const overtaken =
        intent.command === "bid" && !settled.forFinal && outcome.lotVersion > 0
          ? await overtakenPrice(
              await readAfter(),
              context.viewer,
              context.auction,
            )
          : undefined;
      return acceptedBody(lot, intent, amount, outcome.lotVersion, {
        favorites: await settled.autoFollowNote,
        ...(overtaken === undefined ? {} : { overtaken }),
        ...(extension === undefined ? {} : { extension }),
        ...(settled.forFinal ? { forFinal: true as const } : {}),
        ...(settled.liveFinal ? { liveFinal: true as const } : {}),
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
  before: LotView,
  readAfter: () => Promise<LotView | undefined>,
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
  const after = await readAfter();
  if (after === undefined) return undefined;
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

// Ручную ставку называем перебитой автоставкой, только когда хронология
// доказывает ровно одну чужую несненую ставку по новой цене и она прокси —
// тот же разбор, что у вести «перебили» (PER-840). Лидер после команды не
// ставивший сам по себе не доказательство: в окне перечитки это может быть
// чужая ручная или ставка зала. Лот не перечитался, лидерство осталось,
// чтение хронологии отказало или происхождение неоднозначно — нейтральный
// ответ, без слова «автоставка».
async function overtakenPrice(
  after: LotView | undefined,
  viewer: Viewer,
  auction: AuctionPort,
): Promise<Money | undefined> {
  if (after === undefined) return undefined;
  const { status } = after;
  if (
    status.kind !== "trading" ||
    status.leaderId === undefined ||
    status.leaderId === viewer.identityId
  ) {
    return undefined;
  }
  try {
    const origin = await readOutbidOrigin(
      (pageToken) =>
        auction.listLotHistory({
          viewer,
          lotId: after.lotId,
          pageToken,
        }),
      status.currentPrice.minorUnits,
      viewer.identityId,
    );
    return origin === "proxy" ? status.currentPrice : undefined;
  } catch {
    return undefined;
  }
}

async function overtakenOnCommand(
  after: LotView,
  viewer: Viewer,
  auction: AuctionPort,
): Promise<boolean> {
  return (await overtakenPrice(after, viewer, auction)) !== undefined;
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
  notes: {
    favorites: boolean;
    extension?: BidExtension;
    forFinal?: true;
    overtaken?: Money;
    liveFinal?: true;
  },
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
        ...(notes.overtaken === undefined
          ? {}
          : { overtaken: notes.overtaken }),
        ...(notes.extension === undefined
          ? {}
          : { extension: notes.extension }),
        ...(notes.forFinal === true ? { forFinal: true as const } : {}),
        ...(notes.liveFinal === true ? { liveFinal: true as const } : {}),
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

// В онлайне без лидера автоставка сразу ставит порог `nextPrice` — стартовую
// цену (П-01). В живом финале цена зависит от скрытых лимитов, поэтому экран
// описывает пересчёт, а не обещает конкретную ставку.
function firstProxyBid(input: { lot: LotView; pending: PendingCommand }): {
  firstBid?: Money;
} {
  const { lot, pending } = input;
  const { status } = lot;
  const firstBid = lot.nextPrice;
  if (
    pending.command !== "proxy" ||
    status.kind !== "trading" ||
    status.phase !== "online" ||
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

function minimumProxyLimitOf(lot: LotView): Money | undefined {
  const { status } = lot;
  if (status.kind === "held") return status.currentPrice;
  if (status.kind !== "trading") return undefined;
  if (
    status.phase === "live" &&
    status.ask !== undefined &&
    status.ask.minorUnits > status.currentPrice.minorUnits
  ) {
    return status.ask;
  }
  return status.currentPrice;
}

// Вопрос с `force_reply`. Шаг и адресат едут в «Отмене»: ответ вернёт их в
// `reply_to_message`, и вопрос переживёт рестарт процесса.
function questionBody(
  context: CommandContext,
  lot: LotView,
  intent: QuestionIntent,
  explainedBefore: boolean,
): AuctionScreenBody {
  // Лимит удержанному лоту (PER-821) и живому финалу (PER-823) объясняется
  // своим текстом, без примера и кнопки пояснения для онлайн-недели.
  const forFinal = intent.question === "proxy" && lot.status.kind === "held";
  const liveFinal =
    intent.question === "proxy" &&
    lot.status.kind === "trading" &&
    lot.status.phase === "live";
  const explained = explainedBefore && !forFinal && !liveFinal;
  const current =
    intent.question === "bid"
      ? lot.nextPrice
      : intent.question === "proxy"
        ? (lot.viewerProxyLimit ??
          (forFinal
            ? undefined
            : liveFinal
              ? minimumProxyLimitOf(lot)
              : lot.nextPrice))
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
        ...(forFinal ? { forFinal: true as const } : {}),
        ...(liveFinal ? { liveFinal: true as const } : {}),
      },
    ],
    keyboard: [
      ...(intent.question === "proxy" && !explained && !forFinal && !liveFinal
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
  const offered = offeredFor(lot, command);
  if (offered === undefined) {
    return resultBody(lot, intent.page, notOffered(command, lot));
  }
  const amount = parseAmount(text, offered.currentPrice.currency);
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
// мешает. В живом финале подтверждения нет (ADR-049): нажатие «Поставить» уже
// было, и ставка уходит сразу, если цена кнопки всё ещё следующая (PER-713).
// Цена ушла, пока выбирали имя, — ставкой она не становится: карточка с новой
// ценой и строкой «цена изменилась», а жмёт человек уже на неё.
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
    // Сразу уходит только ставка, начатая кнопкой финала: ставка онлайн-недели
    // ждала своего «Да», и выход лота в финал её не подтверждает — человек
    // видит карточку финала и жмёт «Поставить» сам.
    if (pending.final !== true) return showLot({ ...context, lot, page });
    // Лидирует уже сам смотрящий — поставил из другого окна, пока висел этот
    // экран: кнопки ставки у лидера нет, и карточка говорит, что цена его.
    if (lot.status.leaderId === context.viewer.identityId) {
      return showLot({
        ...context,
        lot,
        page,
        finalBid: {
          kind: "refused",
          refusal: {
            kind: "bidder-is-leader",
            currentPrice: lot.status.currentPrice,
          },
        },
      });
    }
    const next = lot.nextPrice;
    if (next !== undefined && next.minorUnits === pending.amount) {
      return placeFinalBidOn(context, lot, {
        lotId: lot.lotId,
        amount: pending.amount,
        page,
      });
    }
    const changed: FinalBidOutcome | undefined =
      next === undefined ? undefined : { kind: "price-changed", next };
    return showLot({
      ...context,
      lot,
      page,
      ...(changed === undefined ? {} : { finalBid: changed }),
    });
  }
  return confirmOrRefuse(context, lot, pending, page, true);
}
