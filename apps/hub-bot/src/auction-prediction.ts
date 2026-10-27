import type { AnswerRefusal, AuctionBlock, Money } from "./auction-ui/index.js";
import {
  predictionNominationsFor,
  predictionSpec,
} from "./auction-ui/index.js";

export const predictionButtonLabel = "Прогнозы";
export const predictionTitle = "Прогнозы аукциона";

export function predictionRoundTitle(round: "catalog" | "final"): string {
  return round === "catalog" ? "Раунд 1 · Каталог" : "Раунд 2 · Финал";
}

export type PredictionTextOptions = {
  moment: (instant: string) => string;
  money: (amount: Money) => string;
};

export function predictionParagraphs(
  block: Extract<AuctionBlock, { kind: "prediction" }>,
  options: PredictionTextOptions,
): string[] {
  const condition = (() => {
    if (block.status === "cancelled") {
      return "Прогнозы отменены: итогов не будет.";
    }
    if (block.status === "closed") {
      return block.answers.length === 0
        ? "Раунд закрыт. Ответов нет."
        : "Раунд закрыт. <b>Прогноз зафиксирован.</b>";
    }
    if (block.round === "catalog") {
      return block.closesAt === undefined
        ? "Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов."
        : `Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов — ${escapeHtml(options.moment(block.closesAt))}.`;
    }
    return block.status === "not-open"
      ? "Раунд откроется после объявления состава финала и закроется при старте финала."
      : "Прогнозы закроются при старте финала.";
  })();
  const answers = new Map(
    block.answers.map((answer) => [answer.nomination, answer]),
  );
  const staleNominations = new Set(block.staleNominations ?? []);
  const lines = predictionNominationsFor(block.round).map((nomination) => {
    const answer = answers.get(nomination.id);
    const stale = staleNominations.has(nomination.id)
      ? " <i>лот больше не входит в раунд; ответ не засчитается</i>"
      : "";
    return `• <b>${nomination.number}</b> — ${escapeHtml(nomination.question)} ${
      answer === undefined
        ? "<i>пока без ответа</i>"
        : escapeHtml(
            predictionAnswerText(
              answer,
              block.lotNames,
              block.currency ?? "RUB",
              options.money,
            ),
          )
    }${stale}`;
  });
  return [
    condition,
    ...(block.notice === undefined
      ? []
      : [
          (() => {
            switch (block.notice) {
              case "lot-not-in-round":
                return "Этот лот больше не входит в раунд. Выбери другой.";
              case "round-closed":
                return "Раунд закрылся, пока ты отвечал. Новый ответ не принят.";
              case "stale-answer-removed":
                return "Ответ на снятый лот удалён; остальные изменения сохранены.";
              case "unanswered":
                return "Не удалось подтвердить сохранение. Ответ мог сохраниться; проверь прогноз перед повтором.";
              default: {
                const _exhaustive: never = block.notice;
                return _exhaustive;
              }
            }
          })(),
        ]),
    ...lines,
  ];
}

function predictionAnswerText(
  answer: Extract<AuctionBlock, { kind: "prediction" }>["answers"][number],
  lotNames: Readonly<Record<string, string>>,
  currency: string,
  money: (amount: Money) => string,
): string {
  switch (answer.answer.kind) {
    case "lot":
      return lotNames[answer.answer.lotId] ?? "лот больше недоступен";
    case "number": {
      const nomination = predictionSpec(answer.nomination);
      return nomination.answer === "money"
        ? money({ minorUnits: answer.answer.value, currency })
        : new Intl.NumberFormat("ru-RU").format(answer.answer.value);
    }
    default: {
      const _exhaustive: never = answer.answer;
      return _exhaustive;
    }
  }
}

export function predictionNumberQuestionText(
  block: Extract<AuctionBlock, { kind: "prediction-number-question" }>,
  money: (amount: Money) => string,
): string[] {
  const nomination = predictionSpec(block.nomination);
  const instruction =
    nomination.answer === "money"
      ? "Пришли сумму в рублях, например: 12 500 или 12 500,50."
      : "Пришли целое число, например: 42.";
  const current =
    block.currentValue === undefined
      ? undefined
      : nomination.answer === "money"
        ? `Сейчас указано: ${money({
            minorUnits: block.currentValue,
            currency: block.currency ?? "RUB",
          })}.`
        : `Сейчас указано: ${new Intl.NumberFormat("ru-RU").format(block.currentValue)}.`;
  return current === undefined ? [instruction] : [instruction, current];
}

export function predictionNameChoiceText(username: string | undefined): string {
  return [
    "Имя видно всем участникам аукциона рядом с твоими ставками; если угадаешь, его покажут в итогах прогнозов. Чужие прогнозы не раскрываются. После первой ставки имя не поменять.",
    username === undefined
      ? "Ника в Telegram у тебя нет: возьми псевдоним."
      : `Ставь под ником @${escapeHtml(username)} или возьми псевдоним.`,
  ].join("\n");
}

export function predictionRefusalText(refusal: AnswerRefusal): {
  title: string;
  detail?: string;
} {
  switch (refusal) {
    case "not-text":
      return { title: "Нужен ответ текстом" };
    case "not-a-number":
      return { title: "Введи число без лишних символов" };
    case "other-currency":
      return { title: "Укажи сумму в рублях" };
    case "not-positive":
      return { title: "Число не может быть отрицательным" };
    case "too-precise":
      return { title: "Копеек — не больше двух знаков" };
    case "too-large":
      return { title: "Это число слишком большое" };
    case "username-missing":
      return {
        title: "Ника в Telegram у тебя нет",
        detail: "Возьми псевдоним.",
      };
    case "alias-invalid":
      return { title: "Такой псевдоним не подходит" };
    case "alias-taken":
      return { title: "Этот псевдоним уже занят" };
    case "name-frozen":
      return {
        title: "Имя уже не поменять",
        detail: "Ты ставил в этом аукционе.",
      };
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
