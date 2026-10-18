import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  DisplayNameChoice,
  DisplayNameRefusal,
  LotView,
  PredictionAnswer,
  PredictionOutcome,
  PredictionRoundView,
} from "../../ports.js";
import type {
  PredictionNomination,
  PredictionRound,
} from "../../prediction-spec.js";
import {
  predictionNominationsFor,
  predictionSpec,
} from "../../prediction-spec.js";
import type {
  AnswerRefusal,
  AuctionButton,
  AuctionScreenBody,
} from "../../screen.js";
import { collectPages } from "./collect-pages.js";
import { type CommandContext, withOneRetry } from "./commands.js";
import { feedItemOf } from "./standing.js";

const LOT_PAGE_SIZE = 7;
const MAX_PREDICTION_LOTS = 8_000;
const MAX_PREDICTION_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

type PredictionContext = Pick<
  CommandContext,
  "auction" | "operations" | "user" | "viewer"
>;

type PredictionNominationContext = {
  auctionId: string;
  round: PredictionRound;
  nomination: PredictionNomination;
};

const toRound = (auctionId: string, round: PredictionRound): string =>
  encodeAuctionCallback({ kind: "prediction", auctionId, round });

// Прогнозы — ребёнок корня аукциона (PER-644): возврат ведёт туда же, куда у
// ленты, розыгрыша и избранного.
const toRoot = (auctionId: string): AuctionButton => ({
  action: "prediction.back",
  callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
});

async function roundView(
  context: PredictionContext,
  auctionId: string,
  round: PredictionRound,
): Promise<PredictionRoundView> {
  const rounds = await context.auction.getMyPredictions({
    viewer: context.viewer,
    auctionId,
  });
  const found = rounds.find((each) => each.round === round);
  if (found === undefined) {
    throw new Error(`GetMyPredictions omitted the ${round} round`);
  }
  return found;
}

async function opensAt(
  context: PredictionContext,
  auctionId: string,
): Promise<string | undefined> {
  return (
    await context.auction.getAuction({ viewer: context.viewer, auctionId })
  )?.opensAt;
}

async function predictionLotDetails(
  context: PredictionContext,
  round: PredictionRound,
  roundIsOpen: boolean,
  answers: readonly PredictionAnswer[],
): Promise<{
  names: Readonly<Record<string, string>>;
  staleNominations: readonly PredictionNomination[];
}> {
  const nominationsByLot = new Map<string, PredictionNomination[]>();
  for (const answer of answers) {
    if (answer.answer.kind !== "lot") continue;
    const nominations = nominationsByLot.get(answer.answer.lotId) ?? [];
    nominations.push(answer.nomination);
    nominationsByLot.set(answer.answer.lotId, nominations);
  }
  const stale = new Set<PredictionNomination>();
  const entries = await Promise.all(
    [...nominationsByLot.keys()].map(
      async (lotId): Promise<readonly [string, string] | undefined> => {
        const lot = await context.auction.findLot({
          viewer: context.viewer,
          lotId,
        });
        if (roundIsOpen && !isPredictionCandidate(round, lot)) {
          for (const nomination of nominationsByLot.get(lotId) ?? []) {
            stale.add(nomination);
          }
        }
        return lot?.card === undefined ? undefined : [lotId, lot.card.title];
      },
    ),
  );
  return {
    names: Object.fromEntries(entries.filter((entry) => entry !== undefined)),
    staleNominations: [...stale],
  };
}

function isPredictionCandidate(
  round: PredictionRound,
  lot: LotView | undefined,
): boolean {
  if (lot?.card === undefined) return false;
  return round === "catalog"
    ? lot.status.kind !== "withdrawn"
    : lot.status.kind === "held";
}

export async function openPrediction(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    notice?:
      | "lot-not-in-round"
      | "round-closed"
      | "stale-answer-removed"
      | "unanswered";
  },
): Promise<AuctionScreenBody> {
  const [round, openAt] = await Promise.all([
    roundView(context, input.auctionId, input.round),
    input.round === "catalog"
      ? opensAt(context, input.auctionId)
      : Promise.resolve(undefined),
  ]);
  // Отказ Auction является авторитетным даже если чтение состояния отстаёт.
  const status = input.notice === "round-closed" ? "closed" : round.status;
  const lotDetails = await predictionLotDetails(
    context,
    input.round,
    status === "open",
    round.answers,
  );
  const nominations = predictionNominationsFor(input.round);
  const keyboard =
    status !== "open"
      ? []
      : nominations.map((nomination) => [
          {
            action: "prediction.edit" as const,
            callbackData: encodeAuctionCallback({
              kind: "prediction-edit",
              auctionId: input.auctionId,
              round: input.round,
              nomination: nomination.id,
            }),
          },
        ]);
  return {
    blocks: [
      {
        kind: "prediction",
        auctionId: input.auctionId,
        round: input.round,
        status,
        answers: round.answers,
        lotNames: lotDetails.names,
        ...(lotDetails.staleNominations.length === 0
          ? {}
          : { staleNominations: lotDetails.staleNominations }),
        ...(openAt === undefined ? {} : { opensAt: openAt }),
        ...(input.notice === undefined ? {} : { notice: input.notice }),
      },
    ],
    keyboard: [
      ...keyboard,
      [
        {
          action: "prediction.switch-round",
          callbackData: toRound(
            input.auctionId,
            input.round === "catalog" ? "final" : "catalog",
          ),
        },
      ],
      [toRoot(input.auctionId)],
    ],
  };
}

export async function editPrediction(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
    page?: number;
  },
): Promise<AuctionScreenBody> {
  const current = await roundView(context, input.auctionId, input.round);
  if (current.status === "closed") {
    return openPrediction(context, { ...input, notice: "round-closed" });
  }
  if (current.status !== "open") {
    return openPrediction(context, input);
  }
  const answer = current.answers.find(
    (each) => each.nomination === input.nomination,
  );
  if (predictionSpec(input.nomination).answer === "lot") {
    return openPredictionLots(context, {
      ...input,
      page: input.page ?? 0,
      ...(answer?.answer.kind === "lot"
        ? { currentLotId: answer.answer.lotId }
        : {}),
    });
  }
  const nomination = input.nomination;
  return predictionNumberQuestion(context, {
    ...input,
    nomination,
    ...(answer?.answer.kind === "number"
      ? { currentValue: answer.answer.value }
      : {}),
  });
}

async function candidateLots(
  context: PredictionContext,
  auctionId: string,
  round: PredictionRound,
): Promise<LotView[]> {
  const all = await collectPages({
    what: "prediction lot list",
    maxItems: MAX_PREDICTION_LOTS,
    fetch: async (pageToken) => {
      const page = await context.auction.listAuctionLots({
        viewer: context.viewer,
        auctionId,
        pageToken,
      });
      return { items: page.lots, nextPageToken: page.nextPageToken };
    },
  });
  const candidates =
    round === "catalog"
      ? all.filter(
          (lot) => lot.card !== undefined && lot.status.kind !== "withdrawn",
        )
      : all.filter(
          (lot) => lot.card !== undefined && lot.status.kind === "held",
        );
  return candidates.sort((a, b) => {
    const titleA = a.card?.title ?? "";
    const titleB = b.card?.title ?? "";
    return titleA.localeCompare(titleB, "ru") || lotIdOrder(a, b);
  });
}

function lotIdOrder(a: LotView, b: LotView): number {
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

async function openPredictionLots(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
    page: number;
    currentLotId?: string;
  },
): Promise<AuctionScreenBody> {
  const [current, all] = await Promise.all([
    roundView(context, input.auctionId, input.round),
    candidateLots(context, input.auctionId, input.round),
  ]);
  if (current.status !== "open") {
    return openPrediction(context, {
      ...input,
      ...(current.status === "closed" ? { notice: "round-closed" } : {}),
    });
  }
  const pageCount = Math.max(1, Math.ceil(all.length / LOT_PAGE_SIZE));
  const page = Math.min(input.page, pageCount - 1);
  const shown = all.slice(page * LOT_PAGE_SIZE, (page + 1) * LOT_PAGE_SIZE);
  const answer = current.answers.find(
    (each) => each.nomination === input.nomination,
  );
  const currentLotId =
    answer?.answer.kind === "lot" ? answer.answer.lotId : input.currentLotId;
  const currentLot =
    currentLotId === undefined
      ? undefined
      : all.find((lot) => lot.lotId === currentLotId);
  return {
    blocks: [
      {
        kind: "prediction-lots",
        auctionId: input.auctionId,
        round: input.round,
        nomination: input.nomination,
        page,
        pageCount,
        lots: shown.map((lot) => feedItemOf(lot, context.viewer)),
        ...(currentLotId === undefined ? {} : { currentLotId }),
        ...(currentLot?.card === undefined
          ? {}
          : { currentTitle: currentLot.card.title }),
      },
    ],
    keyboard: [
      ...shown.map((lot) => [
        {
          action: "prediction.select-lot" as const,
          lotId: lot.lotId,
          callbackData: encodeAuctionCallback({
            kind: "prediction-lot",
            auctionId: input.auctionId,
            round: input.round,
            nomination: input.nomination,
            lotId: lot.lotId,
          }),
        },
      ]),
      ...(currentLotId === undefined
        ? []
        : [
            [
              {
                action: "prediction.clear" as const,
                callbackData: clearCallback(input),
              },
            ],
          ]),
      ...(pageCount > 1
        ? [
            [
              ...(page > 0
                ? [
                    {
                      action: "feed.prev" as const,
                      callbackData: encodeAuctionCallback({
                        kind: "prediction-lots",
                        auctionId: input.auctionId,
                        round: input.round,
                        nomination: input.nomination,
                        page: page - 1,
                      }),
                    },
                  ]
                : []),
              ...(page < pageCount - 1
                ? [
                    {
                      action: "feed.next" as const,
                      callbackData: encodeAuctionCallback({
                        kind: "prediction-lots",
                        auctionId: input.auctionId,
                        round: input.round,
                        nomination: input.nomination,
                        page: page + 1,
                      }),
                    },
                  ]
                : []),
            ],
          ]
        : []),
      [toRoundButton(input.auctionId, input.round, "prediction.back")],
    ],
  };
}

function toRoundButton(
  auctionId: string,
  round: PredictionRound,
  action: "prediction.back",
): AuctionButton {
  return {
    action,
    callbackData: toRound(auctionId, round),
  };
}

function clearCallback(input: {
  auctionId: string;
  round: PredictionRound;
  nomination: PredictionAnswer["nomination"];
}): string {
  const { auctionId, round, nomination } = input;
  return encodeAuctionCallback({
    kind: "prediction-clear",
    auctionId,
    round,
    nomination,
  });
}

async function predictionNumberQuestion(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
    currentValue?: number;
  },
): Promise<AuctionScreenBody> {
  return {
    blocks: [
      {
        kind: "prediction-number-question",
        auctionId: input.auctionId,
        round: input.round,
        nomination: input.nomination,
        ...(input.currentValue === undefined
          ? {}
          : { currentValue: input.currentValue }),
      },
    ],
    keyboard: [
      ...(input.currentValue === undefined
        ? []
        : [
            [
              {
                action: "prediction.clear" as const,
                callbackData: clearCallback(input),
              },
            ],
          ]),
      [
        {
          action: "question.cancel",
          callbackData: encodeAuctionCallback({
            kind: "prediction-number-question",
            auctionId: input.auctionId,
            round: input.round,
            nomination: input.nomination,
            addressee: context.user.telegramUserId,
          }),
        },
      ],
    ],
  };
}

export async function answerPredictionNumber(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
    text?: string;
  },
): Promise<AuctionScreenBody> {
  if (input.text === undefined) {
    return refusedPredictionAnswer(context, input, "not-text");
  }
  const kind = predictionSpec(input.nomination).answer;
  const parsed = parsePredictionValue(input.text, kind);
  if (!parsed.ok) {
    return refusedPredictionAnswer(context, input, parsed.refusal);
  }
  return submitAnswer(context, {
    auctionId: input.auctionId,
    round: input.round,
    answer: {
      nomination: input.nomination,
      answer: { kind: "number", value: parsed.value },
    },
  });
}

export async function submitPredictionLot(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
    lotId: string;
  },
): Promise<AuctionScreenBody> {
  return submitAnswer(context, {
    auctionId: input.auctionId,
    round: input.round,
    answer: {
      nomination: input.nomination,
      answer: { kind: "lot", lotId: input.lotId },
    },
  });
}

export async function clearPredictionNomination(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    nomination: PredictionAnswer["nomination"];
  },
): Promise<AuctionScreenBody> {
  return submitAnswer(context, { ...input, clear: input.nomination });
}

async function submitAnswer(
  context: PredictionContext,
  input: {
    auctionId: string;
    round: PredictionRound;
    answer?: PredictionAnswer;
    clear?: PredictionAnswer["nomination"];
  },
): Promise<AuctionScreenBody> {
  const current = await roundView(context, input.auctionId, input.round);
  if (current.status === "closed") {
    return openPrediction(context, { ...input, notice: "round-closed" });
  }
  if (current.status !== "open") {
    return openPrediction(context, input);
  }
  let answers = current.answers.filter(
    (each) =>
      each.nomination !== input.answer?.nomination &&
      each.nomination !== input.clear,
  );
  if (input.answer !== undefined) answers.push(input.answer);
  answers.sort(
    (a, b) =>
      predictionNominationsFor(input.round).findIndex(
        (spec) => spec.id === a.nomination,
      ) -
      predictionNominationsFor(input.round).findIndex(
        (spec) => spec.id === b.nomination,
      ),
  );
  const request = {
    viewer: context.viewer,
    auctionId: input.auctionId,
    round: input.round,
  };
  const submit = (submission: readonly PredictionAnswer[]) => {
    const opId = context.operations.newOperationId();
    return withOneRetry(() =>
      context.auction.submitPrediction({
        ...request,
        answers: submission,
        opId,
      }),
    );
  };
  let outcome = await submit(answers);
  let removedStaleAnswer = false;
  while (
    outcome.kind === "refused" &&
    outcome.refusal.kind === "lot-not-in-round"
  ) {
    const { nomination, lotId } = outcome.refusal;
    const staleIndex = answers.findIndex(
      (each) =>
        each.nomination === nomination &&
        each.answer.kind === "lot" &&
        each.answer.lotId === lotId,
    );
    if (staleIndex === -1) break;
    const isNewAnswer =
      input.answer?.nomination === nomination &&
      input.answer.answer.kind === "lot" &&
      input.answer.answer.lotId === lotId;
    if (isNewAnswer) break;
    answers = answers.filter((_, index) => index !== staleIndex);
    removedStaleAnswer = true;
    // The payload changed after a definitive refusal, so it gets a fresh op_id.
    outcome = await submit(answers);
  }
  if (
    outcome.kind === "refused" &&
    outcome.refusal.kind === "display-name-not-chosen"
  ) {
    const nomination = input.answer?.nomination ?? input.clear;
    if (nomination === undefined) {
      throw new Error("prediction name choice without a nomination");
    }
    return predictionNameChoice(context, {
      auctionId: input.auctionId,
      round: input.round,
      nomination,
    });
  }
  return settlePrediction(context, input, outcome, removedStaleAnswer);
}

async function settlePrediction(
  context: PredictionContext,
  input: { auctionId: string; round: PredictionRound },
  outcome: PredictionOutcome,
  removedStaleAnswer: boolean,
): Promise<AuctionScreenBody> {
  const notice = (() => {
    if (outcome.kind === "unanswered") return "unanswered";
    if (outcome.kind === "refused") {
      if (outcome.refusal.kind === "round-closed") return "round-closed";
      if (outcome.refusal.kind === "lot-not-in-round")
        return "lot-not-in-round";
    }
    return outcome.kind === "accepted" && removedStaleAnswer
      ? "stale-answer-removed"
      : undefined;
  })();
  return openPrediction(context, {
    ...input,
    ...(notice === undefined ? {} : { notice }),
  });
}

function predictionNameChoice(
  context: PredictionContext,
  input: PredictionNominationContext,
): AuctionScreenBody {
  const username = context.user.telegramUsername;
  const hasUsername = username !== undefined && username !== "";
  return {
    blocks: [
      {
        kind: "prediction-name-choice",
        auctionId: input.auctionId,
        round: input.round,
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
                  kind: "prediction-username",
                  auctionId: input.auctionId,
                  round: input.round,
                  nomination: input.nomination,
                }),
              },
            ],
          ]
        : []),
      [
        {
          action: "name.alias",
          callbackData: encodeAuctionCallback({
            kind: "prediction-ask-alias",
            auctionId: input.auctionId,
            round: input.round,
            nomination: input.nomination,
          }),
        },
      ],
      [toRoundButton(input.auctionId, input.round, "prediction.back")],
    ],
  };
}

export function askPredictionAlias(
  context: PredictionContext,
  input: PredictionNominationContext,
): AuctionScreenBody {
  const { auctionId, round, nomination } = input;
  return {
    blocks: [
      {
        kind: "prediction-alias-question",
        auctionId,
        round,
        nomination,
      },
    ],
    keyboard: [
      [
        {
          action: "question.cancel",
          callbackData: encodeAuctionCallback({
            kind: "prediction-alias-question",
            auctionId,
            round,
            nomination,
            addressee: context.user.telegramUserId,
          }),
        },
      ],
    ],
  };
}

export function cancelPredictionAlias(
  context: PredictionContext,
  input: PredictionNominationContext,
): AuctionScreenBody {
  return predictionNameChoice(context, input);
}

export async function choosePredictionUsername(
  context: PredictionContext,
  input: PredictionNominationContext,
): Promise<AuctionScreenBody> {
  return choosePredictionName(context, input, {
    kind: "username",
    username: context.user.telegramUsername ?? "",
  });
}

export async function answerPredictionAlias(
  context: PredictionContext,
  input: PredictionNominationContext & { text?: string },
): Promise<AuctionScreenBody> {
  if (input.text === undefined) {
    return refusedPredictionName(input, "not-text");
  }
  return choosePredictionName(context, input, {
    kind: "alias",
    alias: input.text,
  });
}

async function choosePredictionName(
  context: PredictionContext,
  input: PredictionNominationContext,
  choice: DisplayNameChoice,
): Promise<AuctionScreenBody> {
  const result = await context.auction.chooseDisplayName({
    viewer: context.viewer,
    auctionId: input.auctionId,
    choice,
  });
  if (result.kind === "refused" && result.refusal !== "name-frozen") {
    return refusedPredictionName(input, result.refusal);
  }
  return editPrediction(context, input);
}

function refusedPredictionName(
  input: PredictionNominationContext,
  refusal: "not-text" | DisplayNameRefusal,
): AuctionScreenBody {
  const { auctionId, round, nomination } = input;
  return {
    blocks: [
      {
        kind: "prediction-answer-refused",
        auctionId,
        round,
        nomination,
        refusal,
      },
    ],
    keyboard: [
      [
        {
          action: "answer.retry",
          callbackData: encodeAuctionCallback({
            kind: "prediction-ask-alias",
            auctionId,
            round,
            nomination,
          }),
        },
      ],
      [toRoundButton(input.auctionId, input.round, "prediction.back")],
    ],
  };
}

function refusedPredictionAnswer(
  context: PredictionContext,
  input: PredictionNominationContext,
  refusal: AnswerRefusal,
): AuctionScreenBody {
  return {
    blocks: [
      {
        kind: "prediction-answer-refused",
        auctionId: input.auctionId,
        round: input.round,
        nomination: input.nomination,
        refusal,
      },
    ],
    keyboard: [
      [
        {
          action: "answer.retry",
          callbackData:
            predictionSpec(input.nomination).answer === "lot"
              ? encodeAuctionCallback({
                  kind: "prediction-edit",
                  auctionId: input.auctionId,
                  round: input.round,
                  nomination: input.nomination,
                })
              : encodeAuctionCallback({
                  kind: "prediction-number-question",
                  auctionId: input.auctionId,
                  round: input.round,
                  nomination: input.nomination,
                  addressee: context.user.telegramUserId,
                }),
        },
      ],
      [toRoundButton(input.auctionId, input.round, "prediction.back")],
    ],
  };
}

function parsePredictionValue(
  text: string,
  kind: "money" | "count" | "lot",
):
  | { ok: true; value: number }
  | {
      ok: false;
      refusal: Extract<
        AnswerRefusal,
        "not-a-number" | "too-precise" | "too-large" | "other-currency"
      >;
    } {
  if (kind === "lot") return { ok: false, refusal: "not-a-number" };
  const trimmed = text.trim().toLowerCase();
  const foreign = /[$€£¥]|\b(usd|eur|gbp|cny)\b|доллар|бакс|евро|юан/i;
  if (foreign.test(trimmed)) return { ok: false, refusal: "other-currency" };
  const bare = trimmed
    .replace(/(?:₽|руб(?:ль|ля|лей)?\.?|р\.?)$/i, "")
    .replace(/^(?:₽|руб(?:ль|ля|лей)?\.?|р\.?)\s*/i, "")
    .trim();
  const match = /^(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d+))?$/.exec(
    bare,
  );
  if (match === null) return { ok: false, refusal: "not-a-number" };
  const fraction = match[2] ?? "";
  if (kind === "count" && fraction !== "") {
    return { ok: false, refusal: "not-a-number" };
  }
  if (kind === "money" && fraction.length > 2) {
    return { ok: false, refusal: "too-precise" };
  }
  const whole = (match[1] ?? "").replace(/[ \u00a0\u202f]/g, "");
  const value =
    BigInt(whole) * (kind === "money" ? 100n : 1n) +
    (kind === "money" ? BigInt(fraction.padEnd(2, "0") || "0") : 0n);
  if (value > MAX_PREDICTION_VALUE) {
    return { ok: false, refusal: "too-large" };
  }
  return { ok: true, value: Number(value) };
}
