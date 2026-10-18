export const PREDICTION_ROUNDS = ["catalog", "final"] as const;
export type PredictionRound = (typeof PREDICTION_ROUNDS)[number];

export const PREDICTION_NOMINATIONS = [
  {
    code: "1",
    id: "catalog-most-expensive-lot",
    round: "catalog",
    number: "1.1",
    answer: "lot",
    question: "Какой лот станет самым дорогим?",
  },
  {
    code: "2",
    id: "catalog-total-sales",
    round: "catalog",
    number: "1.2",
    answer: "money",
    question: "Сколько соберём всего?",
  },
  {
    code: "3",
    id: "catalog-most-bids-lot",
    round: "catalog",
    number: "1.3",
    answer: "lot",
    question: "Какой лот получит больше всего ставок?",
  },
  {
    code: "4",
    id: "catalog-biggest-growth-lot",
    round: "catalog",
    number: "1.4",
    answer: "lot",
    question: "Какой лот вырастет сильнее всех от стартовой цены?",
  },
  {
    code: "5",
    id: "catalog-most-bidders-lot",
    round: "catalog",
    number: "1.5",
    answer: "lot",
    question: "За какой лот поборется больше всего людей?",
  },
  {
    code: "6",
    id: "catalog-total-bids",
    round: "catalog",
    number: "1.6",
    answer: "count",
    question: "Сколько всего ставок сделают?",
  },
  {
    code: "7",
    id: "final-most-expensive-lot",
    round: "final",
    number: "2.1",
    answer: "lot",
    question: "Какой лот финала уйдёт дороже всех?",
  },
  {
    code: "8",
    id: "final-total-sales",
    round: "final",
    number: "2.2",
    answer: "money",
    question: "Сколько соберёт финал?",
  },
  {
    code: "9",
    id: "final-biggest-growth-lot",
    round: "final",
    number: "2.3",
    answer: "lot",
    question: "Какой лот сильнее всех вырастет в финале?",
  },
  {
    code: "a",
    id: "final-total-bids",
    round: "final",
    number: "2.4",
    answer: "count",
    question: "Сколько ставок сделают в финале?",
  },
] as const;

export type PredictionNomination =
  (typeof PREDICTION_NOMINATIONS)[number]["id"];
export type PredictionAnswerKind =
  (typeof PREDICTION_NOMINATIONS)[number]["answer"];
export type PredictionNominationSpec = (typeof PREDICTION_NOMINATIONS)[number];

export function predictionRoundFromCode(
  raw: string | undefined,
): PredictionRound | undefined {
  switch (raw) {
    case "c":
      return "catalog";
    case "f":
      return "final";
    default:
      return undefined;
  }
}

export function predictionRoundCode(round: PredictionRound): string {
  return round === "catalog" ? "c" : "f";
}

export function predictionNominationFromCode(
  raw: string | undefined,
): PredictionNomination | undefined {
  return PREDICTION_NOMINATIONS.find((nomination) => nomination.code === raw)
    ?.id;
}

export function predictionNominationCode(
  nomination: PredictionNomination,
): string {
  const spec = predictionSpec(nomination);
  return spec.code;
}

export function predictionSpec(
  nomination: PredictionNomination,
): PredictionNominationSpec {
  const spec = PREDICTION_NOMINATIONS.find((each) => each.id === nomination);
  if (spec === undefined) {
    throw new Error(`unknown prediction nomination: ${nomination}`);
  }
  return spec;
}

export function predictionNominationsFor(
  round: PredictionRound,
): readonly PredictionNominationSpec[] {
  return PREDICTION_NOMINATIONS.filter(
    (nomination) => nomination.round === round,
  );
}
