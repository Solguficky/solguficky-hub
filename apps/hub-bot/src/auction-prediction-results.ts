import type { AuctionBlock, Money } from "./auction-ui/index.js";
import { predictionSpec } from "./auction-ui/index.js";

export const predictionResultsButtonLabel = "Итоги";
export const predictionResultsTitle = "Итоги прогнозов";
export const predictionResultsAfterFinal = "Итоги после финала.";
export const predictionResultsByHand =
  "Итоги подведены вручную, подсчитанных значений нет.";
export const predictionResultsCancelled =
  "Аукцион отменён, итогов прогнозов нет.";
export const predictionResultsNonePlayed = "Ни одна номинация не разыграна.";

type ResultsBlock = Extract<AuctionBlock, { kind: "prediction-results" }>;
type CountedLine = Extract<
  ResultsBlock["results"],
  { kind: "counted" }
>["nominations"][number];

export function predictionResultsParagraphs(
  block: ResultsBlock,
  options: { money: (amount: Money) => string },
): string[] {
  const { results } = block;
  switch (results.kind) {
    case "after-final":
      return [predictionResultsAfterFinal];
    case "by-hand":
      return [predictionResultsByHand];
    case "cancelled":
      return [predictionResultsCancelled];
    case "counted":
      return results.nominations.length === 0
        ? [predictionResultsNonePlayed]
        : results.nominations.map((line) => nominationText(line, options));
    default: {
      const _exhaustive: never = results;
      return _exhaustive;
    }
  }
}

function nominationText(
  line: CountedLine,
  options: { money: (amount: Money) => string },
): string {
  const spec = predictionSpec(line.nomination);
  const rows = [
    `${spec.number} ${escapeHtml(spec.question)}`,
    `Итог: ${valueText(line, options)}.`,
    winnersText(line.winnerNames, line.winnerCount),
    mineText(line, options),
  ];
  return rows.filter((row) => row !== undefined).join("\n");
}

function valueText(
  line: CountedLine,
  options: { money: (amount: Money) => string },
): string {
  if (line.value.kind === "lots") return joinTitles(line.value.titles);
  const spec = predictionSpec(line.nomination);
  return spec.answer === "money"
    ? options.money({ minorUnits: line.value.value, currency: "RUB" })
    : String(line.value.value);
}

function winnersText(names: readonly string[], winnerCount: number): string {
  const shown = names
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => escapeHtml(name));
  if (shown.length > 0) return `Угадали: ${shown.join(", ")}.`;
  if (winnerCount > 0) return `Угадали: ${winnerCount}.`;
  return "Никто не угадал.";
}

function mineText(
  line: CountedLine,
  options: { money: (amount: Money) => string },
): string {
  const { mine } = line;
  if (mine === undefined) return "Ты эту номинацию не заполнял.";
  if (mine.kind === "guessed") return "Ты угадал.";
  if (mine.deviation === undefined) return "Ты не угадал.";
  const spec = predictionSpec(line.nomination);
  const deviation =
    spec.answer === "money"
      ? options.money({ minorUnits: mine.deviation, currency: "RUB" })
      : String(mine.deviation);
  return `Ты не угадал. Отклонение — ${deviation}.`;
}

function joinTitles(titles: readonly string[]): string {
  const named = titles.map((title) => `«${escapeHtml(title)}»`);
  if (named.length <= 1) return named[0] ?? "лот не назван";
  const last = named[named.length - 1];
  return `${named.slice(0, -1).join(", ")} и ${last}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
