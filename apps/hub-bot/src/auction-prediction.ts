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

// Когда будут итоги (PER-813, ADR-067, пп. 8–9): оба раунда считаются в конце
// аукциона, после финала, по всему аукциону.
export const predictionResultsWhen =
  "Итоги подведём в конце аукциона, после финала, по всему аукциону.";

export function predictionParagraphs(
  block: Extract<AuctionBlock, { kind: "prediction" }>,
  options: PredictionTextOptions,
): string[] {
  const settled = block.results !== undefined;
  const condition = (() => {
    if (block.status === "cancelled") {
      return "Прогнозы отменены: итогов не будет.";
    }
    if (block.status === "closed") {
      const closed =
        block.answers.length === 0
          ? "Раунд закрыт. Ответов нет."
          : "Раунд закрыт. <b>Прогноз зафиксирован.</b>";
      return settled ? closed : `${closed} ${predictionResultsWhen}`;
    }
    if (block.round === "catalog") {
      return `${
        block.closesAt === undefined
          ? "Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов."
          : `Прогноз можно менять всю онлайн-неделю: раунд закроется в момент общего дедлайна торгов — ${escapeHtml(options.moment(block.closesAt))}.`
      } ${predictionResultsWhen}`;
    }
    // Точного часа старта финала нет: раунд закрывается с его стартом.
    return block.status === "not-open"
      ? `Раунд откроется после объявления состава финала. Ответы принимаются до старта финала, точного часа нет. ${predictionResultsWhen}`
      : `Ответы принимаются до старта финала, точного часа нет. ${predictionResultsWhen}`;
  })();
  const notice =
    block.notice === undefined
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
        ];
  if (block.results?.kind === "cancelled") {
    return [condition, ...notice, "Аукцион отменён, итогов прогнозов нет."];
  }
  if (block.results?.kind === "counted") {
    const results = block.results;
    const answers = new Map(
      block.answers.map((answer) => [answer.nomination, answer]),
    );
    const lines = predictionNominationsFor(block.round).map((nomination) => {
      const line = results.nominations.find(
        (each) => each.nomination === nomination.id,
      );
      return line === undefined
        ? `• <b>${nomination.number}</b> — ${escapeHtml(nomination.question)} <i>не разыграна</i>`
        : resultText(
            line,
            answers.get(nomination.id),
            block.lotNames,
            options.money,
          );
    });
    return [condition, ...notice, ...lines];
  }
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
    ...notice,
    ...lines,
    ...(block.results?.kind === "by-hand"
      ? ["Итоги подведены вручную, подсчитанных значений нет."]
      : []),
  ];
}

type ResultLine = Extract<
  NonNullable<Extract<AuctionBlock, { kind: "prediction" }>["results"]>,
  { kind: "counted" }
>["nominations"][number];

// Итог номинации со своим ответом (PER-813): для числа «Твой прогноз: X, итог:
// Y, разница Z», для лота — свой лот рядом с итогом. Разницу считает экран из
// двух чисел, а не берёт «отклонение» Auction без пояснения.
function resultText(
  line: ResultLine,
  answer:
    | Extract<AuctionBlock, { kind: "prediction" }>["answers"][number]
    | undefined,
  lotNames: Readonly<Record<string, string>>,
  money: (amount: Money) => string,
): string {
  const spec = predictionSpec(line.nomination);
  const head = `• <b>${spec.number}</b> — ${escapeHtml(spec.question)}`;
  // Вердикт даёт результат Auction, а не наличие ответа в другом чтении: два
  // чтения могут разойтись.
  const verdict =
    line.mine?.kind === "guessed"
      ? "ты угадал"
      : line.mine?.kind === "missed"
        ? "ты не угадал"
        : answer === undefined
          ? "ты эту номинацию не заполнял"
          : undefined;
  const tail = `${verdict === undefined ? "" : `; ${verdict}`}.${winners(line)}`;
  const format = (value: number): string =>
    spec.answer === "money"
      ? money({ minorUnits: value, currency: "RUB" })
      : new Intl.NumberFormat("ru-RU").format(value);
  if (line.value.kind === "number") {
    const result = line.value.value;
    if (answer === undefined || answer.answer.kind !== "number") {
      return `${head}\nИтог: ${escapeHtml(format(result))}${tail}`;
    }
    const mine = answer.answer.value;
    const difference = Math.abs(mine - result);
    return `${head}\nТвой прогноз: ${escapeHtml(format(mine))}, итог: ${escapeHtml(format(result))}, разница ${escapeHtml(format(difference))}${tail}`;
  }
  const titles = line.value.titles.map((title) => `«${escapeHtml(title)}»`);
  const result = titles.length === 0 ? "лот не назван" : titles.join(", ");
  if (answer === undefined || answer.answer.kind !== "lot") {
    return `${head}\nИтог: ${result}${tail}`;
  }
  const own = lotNames[answer.answer.lotId];
  const mine =
    own === undefined ? "лот больше недоступен" : `«${escapeHtml(own)}»`;
  return `${head}\nТвой лот: ${mine}, итог: ${result}${tail}`;
}

// Кто угадал: имя стирается, число угадавших остаётся (auction_events.proto).
function winners(line: ResultLine): string {
  const shown = line.winnerNames
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => escapeHtml(name));
  if (shown.length > 0 && shown.length < line.winnerCount) {
    return `\nУгадали ${line.winnerCount}: ${shown.join(", ")}.`;
  }
  if (shown.length > 0) return `\nУгадали: ${shown.join(", ")}.`;
  if (line.winnerCount > 0) return `\nУгадали: ${line.winnerCount}.`;
  return "\nНикто не угадал.";
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
