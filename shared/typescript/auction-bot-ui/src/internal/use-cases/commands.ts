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
  LotView,
  Money,
  OperationIdPort,
  ProxyLimitRefusal,
  TelegramUser,
  Viewer,
} from "../../ports.js";
import type {
  AnswerRefusal,
  AuctionScreenBody,
  CommandResult,
} from "../../screen.js";
import { parseAmount } from "./amount.js";
import { showLot } from "./open-lot.js";

// Сырые юзкейсы листа ставки (PER-317). Доступ проверил шлюз; здесь — путь от
// кнопки до команды Auction и обратно к карточке.
export type CommandContext = {
  auction: AuctionPort;
  operations: OperationIdPort;
  viewer: Viewer;
  user: TelegramUser;
};

function readLot(context: CommandContext, lotId: string): Promise<LotView> {
  return context.auction.getLot({ viewer: context.viewer, lotId });
}

const lotCallback = (lotId: string, page: number) =>
  encodeAuctionCallback({ kind: "lot", lotId, page });

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
      ],
      [{ action: "confirm.no", callbackData: lotCallback(lot.lotId, page) }],
    ],
  };
}

// Подтверждают только то, что предлагает карточка: ставку и лимит в
// онлайн-торгах. Устаревшая кнопка или ответ на вопрос после смены состояния
// получают карточку с отказом без похода в Auction с заведомо мёртвой
// командой: удержанный лот называет цену, остальные — «торги не идут».
function confirmOrRefuse(
  context: CommandContext,
  lot: LotView,
  pending: PendingCommand,
  page: number,
): Promise<AuctionScreenBody> {
  const { status } = lot;
  if (status.kind !== "trading" || status.phase !== "online") {
    return showLot({
      ...context,
      lot,
      page,
      result: notOffered(pending.command, lot),
    });
  }
  return Promise.resolve(
    confirmBody(context, lot, pending, status.currentPrice, page),
  );
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
async function withOneRetry<Refusal>(
  call: () => Promise<CommandOutcome<Refusal>>,
): Promise<CommandOutcome<Refusal>> {
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
    return showLot({
      ...context,
      lot,
      page: intent.page,
      result: notOffered(intent.command, lot),
    });
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
  const settled = { context, lot, intent, amount };
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

// Ответ Auction на команду — экран. Принятая и неизвестная команда меняют
// лот, и карточка перечитывается; отказ состояния не меняет, и карточка идёт
// по снимку до команды. Имя не выбрано — экран выбора имени, а не отказ.
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
  },
  outcome: CommandOutcome<Refusal>,
  refused: (refusal: Refusal) => CommandResult,
): Promise<AuctionScreenBody> {
  const { context, lot, intent, amount } = settled;
  switch (outcome.kind) {
    case "accepted":
      return showLot({
        ...context,
        lot: await readLot(context, intent.lotId),
        page: intent.page,
        result: { command: intent.command, kind: "accepted", amount },
      });
    case "unanswered":
      // Бюджет действия мог уйти весь на команду: тогда перечитать лот нечем,
      // и карточка идёт по снимку до команды — исход «неизвестен» важнее
      // свежей цены.
      return showLot({
        ...context,
        lot: await readLot(context, intent.lotId).catch(() => lot),
        page: intent.page,
        result: { command: intent.command, kind: "unknown" },
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
      return showLot({
        ...context,
        lot,
        page: intent.page,
        result: refused(outcome.refusal),
      });
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Первая ставка в аукционе: имя видно всем, и выбрать его нужно до команды
// (ADR-059). Ник предлагается, только если он есть в update.
function nameChoiceBody(
  context: CommandContext,
  lot: LotView,
  pending: PendingCommand,
  page: number,
  refusal?: DisplayNameRefusal,
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
        ...(refusal === undefined ? {} : { refusal }),
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
};

// Вопрос с `force_reply`. Шаг и адресат едут в «Отмене»: ответ вернёт их в
// `reply_to_message`, и вопрос переживёт рестарт процесса.
function questionBody(
  context: CommandContext,
  lot: LotView,
  intent: QuestionIntent,
  refusal?: AnswerRefusal,
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
        ...(refusal === undefined ? {} : { refusal }),
      },
    ],
    keyboard: [
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

export async function askQuestion(
  context: CommandContext,
  intent: QuestionIntent,
): Promise<AuctionScreenBody> {
  return questionBody(context, await readLot(context, intent.lotId), intent);
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

// Ответ на вопрос. Непринятый ответ — тот же вопрос с причиной, а не
// исключение: ввод человека — недоверенная строка.
export async function answerQuestion(
  context: CommandContext,
  intent: QuestionIntent,
  text: string | undefined,
): Promise<AuctionScreenBody> {
  const lot = await readLot(context, intent.lotId);
  if (text === undefined) {
    return questionBody(context, lot, intent, "not-text");
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
      (refusal) => questionBody(context, lot, intent, refusal),
    );
  }
  const command = intent.question;
  const { status } = lot;
  if (status.kind !== "trading" || status.phase !== "online") {
    return showLot({
      ...context,
      lot,
      page: intent.page,
      result: notOffered(command, lot),
    });
  }
  const amount = parseAmount(text, status.currentPrice.currency);
  if (!amount.ok) return questionBody(context, lot, intent, amount.refusal);
  return confirmBody(
    context,
    lot,
    { command, amount: amount.minorUnits },
    status.currentPrice,
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
    (refusal) =>
      nameChoiceBody(context, lot, intent.pending, intent.page, refusal),
  );
}

// Выбор имени и возврат к отложенной команде: после принятого имени человек
// снова видит подтверждение, с новым `op_id`, и жмёт «Да» сам.
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
  if (outcome.kind === "refused") return refused(outcome.refusal);
  return confirmOrRefuse(context, lot, pending, page);
}
