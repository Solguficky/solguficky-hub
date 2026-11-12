import type { LotHistoryEntryView, LotHistoryPage } from "./ports.js";

// Чем перебита ставка смотрящего (PER-840): хронология отдаёт источник, а
// снимок лота — нет. Ставка находится по цене среди несненных ставок не
// смотрящего. Две подходящие (после снятия участника цена могла повториться)
// или ни одной (запись ушла за предел чтения) — ответа нет: экран и весть
// остаются нейтральными. Хронология идёт по возрастанию, и нужная ставка
// стоит ближе к концу: предел страниц у лота с очень длинной историей даёт
// тот же нейтральный ответ.
export function outbidOriginOf(
  entries: readonly LotHistoryEntryView[],
  minorUnits: number,
  recipientId: string,
): "proxy" | "manual" | undefined {
  const matching = entries.filter(
    (entry) =>
      entry.kind === "bid" &&
      entry.removed !== true &&
      entry.participantId !== recipientId &&
      entry.amount.minorUnits === minorUnits,
  );
  const [only] = matching;
  if (matching.length !== 1 || only?.kind !== "bid") return undefined;
  return only.origin.kind === "proxy" ? "proxy" : "manual";
}

// Страниц хронологии, которые ответ на ставку и весть готовы прочитать:
// перебитие приходит на живой лот, а не на лот с тысячей ставок, и долгое
// чтение задержало бы и ответ, и доставку.
const OUTBID_HISTORY_PAGES = 20;

export async function readOutbidOrigin(
  readPage: (pageToken: string) => Promise<LotHistoryPage>,
  minorUnits: number,
  recipientId: string,
): Promise<"proxy" | "manual" | undefined> {
  const entries: LotHistoryEntryView[] = [];
  let pageToken = "";
  for (let pages = 0; pages < OUTBID_HISTORY_PAGES; pages += 1) {
    const page = await readPage(pageToken);
    entries.push(...page.entries);
    if (page.nextPageToken === "") {
      return outbidOriginOf(entries, minorUnits, recipientId);
    }
    pageToken = page.nextPageToken;
  }
  return undefined;
}
