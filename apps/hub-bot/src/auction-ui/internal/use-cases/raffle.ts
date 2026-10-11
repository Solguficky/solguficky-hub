import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  DisplayNameChoice,
  DisplayNameRefusal,
  RaffleOutcome,
  RaffleView,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { type CommandContext, withOneRetry } from "./commands.js";

// Сырые юзкейсы розыгрыша среди участников (ADR-066). Доступ проверил шлюз, а
// право `place_bids` Auction проверяет на каждом вызове. Подтверждения у
// регистрации и отмены нет: до закрытия регистрация обратима с того же экрана
// и наружу ничего не выходит — список билетов виден только после закрытия
// (дизайн-код, «Клавиатура»).

const raffleCallback = (auctionId: string) =>
  encodeAuctionCallback({ kind: "raffle", auctionId });

const toRaffle = (auctionId: string): AuctionButton => ({
  action: "raffle.return",
  callbackData: raffleCallback(auctionId),
});

// Экран розыгрыша. Кнопка регистрации или отмены есть только в окне
// регистрации; вне окна текст объясняет, где розыгрыш. Возврат — в ленту
// аукциона, на первую её страницу.
export function raffleBody(
  auctionId: string,
  raffle: RaffleView | undefined,
): AuctionScreenBody {
  const action: AuctionButton | undefined =
    raffle?.status !== "open"
      ? undefined
      : raffle.registered
        ? {
            action: "raffle.cancel",
            callbackData: encodeAuctionCallback({
              kind: "raffle-cancel",
              auctionId,
            }),
          }
        : {
            action: "raffle.register",
            callbackData: encodeAuctionCallback({
              kind: "raffle-register",
              auctionId,
            }),
          };
  return {
    blocks: [
      {
        kind: "raffle",
        auctionId,
        ...(raffle === undefined ? {} : { raffle }),
      },
    ],
    keyboard: [
      ...(action === undefined ? [] : [[action]]),
      [
        {
          action: "raffle.back",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId,
            page: 0,
          }),
        },
      ],
    ],
  };
}

export async function openRaffle(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  return raffleBody(
    auctionId,
    await context.auction.getRaffle({ viewer: context.viewer, auctionId }),
  );
}

export async function registerForRaffle(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const request = {
    viewer: context.viewer,
    auctionId,
    opId: context.operations.newOperationId(),
  };
  const outcome = await withOneRetry(() =>
    context.auction.registerForRaffle(request),
  );
  if (
    outcome.kind === "refused" &&
    outcome.refusal === "display-name-not-chosen"
  ) {
    return nameChoiceBody(context, auctionId);
  }
  return settle(context, auctionId, outcome);
}

export async function cancelRaffleRegistration(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const request = {
    viewer: context.viewer,
    auctionId,
    opId: context.operations.newOperationId(),
  };
  return settle(
    context,
    auctionId,
    await withOneRetry(() => context.auction.cancelRaffleRegistration(request)),
  );
}

// Принятая команда отвечает розыгрышем после неё. Отказ и неизвестный исход
// показывают розыгрыш, каким он стал: закрытая регистрация объясняется
// статусом, а отметка «ты зарегистрирован» говорит, прошла ли команда.
async function settle<Refusal>(
  context: CommandContext,
  auctionId: string,
  outcome: RaffleOutcome<Refusal>,
): Promise<AuctionScreenBody> {
  return outcome.kind === "accepted"
    ? raffleBody(auctionId, outcome.raffle)
    : openRaffle(context, auctionId);
}

// Выбор имени перед регистрацией: имя попадёт в список «номер — имя» так же,
// как его показывает хронология ставок (ADR-066, п. 3).
function nameChoiceBody(
  context: CommandContext,
  auctionId: string,
): AuctionScreenBody {
  const username = context.user.telegramUsername;
  const hasUsername = username !== undefined && username !== "";
  return {
    blocks: [
      {
        kind: "raffle-name-choice",
        auctionId,
        ...(hasUsername ? { username } : {}),
      },
    ],
    keyboard: [
      ...(hasUsername
        ? [
            [
              {
                action: "name.username" as const,
                callbackData: encodeAuctionCallback({
                  kind: "raffle-username",
                  auctionId,
                }),
              },
            ],
          ]
        : []),
      [askAlias(auctionId, "name.alias")],
      [toRaffle(auctionId)],
    ],
  };
}

function askAlias(
  auctionId: string,
  action: "name.alias" | "answer.retry",
): AuctionButton {
  return {
    action,
    callbackData: encodeAuctionCallback({
      kind: "raffle-ask-alias",
      auctionId,
    }),
  };
}

function answerRefusedBody(
  auctionId: string,
  refusal: "not-text" | DisplayNameRefusal,
): AuctionScreenBody {
  // Имя, которое уже не поменять, повтор не спасёт.
  const retry =
    refusal === "name-frozen" ? undefined : askAlias(auctionId, "answer.retry");
  return {
    blocks: [{ kind: "raffle-answer-refused", auctionId, refusal }],
    keyboard: [
      ...(retry === undefined ? [] : [[retry]]),
      [toRaffle(auctionId)],
    ],
  };
}

// Вопрос псевдонима с `force_reply`: шаг и адресат едут в «Отмене».
export function askRaffleAlias(
  context: CommandContext,
  auctionId: string,
): AuctionScreenBody {
  return {
    blocks: [{ kind: "raffle-question", auctionId }],
    keyboard: [
      [
        {
          action: "question.cancel",
          callbackData: encodeAuctionCallback({
            kind: "raffle-question",
            auctionId,
            addressee: context.user.telegramUserId,
          }),
        },
      ],
    ],
  };
}

// «Отмена» под вопросом возвращает в выбор имени.
export function cancelRaffleQuestion(
  context: CommandContext,
  auctionId: string,
): AuctionScreenBody {
  return nameChoiceBody(context, auctionId);
}

export function answerRaffleQuestion(
  context: CommandContext,
  auctionId: string,
  text: string | undefined,
): Promise<AuctionScreenBody> {
  if (text === undefined) {
    return Promise.resolve(answerRefusedBody(auctionId, "not-text"));
  }
  return chooseName(context, auctionId, { kind: "alias", alias: text });
}

export function chooseRaffleUsername(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  return chooseName(context, auctionId, {
    kind: "username",
    username: context.user.telegramUsername ?? "",
  });
}

// Принятое имя сразу ведёт к регистрации: человек уже нажал «Зарегистрироваться»,
// а подтверждения у неё нет.
async function chooseName(
  context: CommandContext,
  auctionId: string,
  choice: DisplayNameChoice,
): Promise<AuctionScreenBody> {
  const outcome = await context.auction.chooseDisplayName({
    viewer: context.viewer,
    auctionId,
    choice,
  });
  // Имя, которое уже не поменять, уже выбрано — например ставкой, сделанной,
  // пока экран выбора висел: регистрации оно не мешает.
  if (outcome.kind === "refused" && outcome.refusal !== "name-frozen") {
    return answerRefusedBody(auctionId, outcome.refusal);
  }
  return registerForRaffle(context, auctionId);
}
