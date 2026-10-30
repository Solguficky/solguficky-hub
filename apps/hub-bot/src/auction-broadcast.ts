import type { LotView, Money } from "./auction-ui/index.js";
import { money as formatMoney } from "./core/format.js";

// Слова трансляции хода торгов (PER-826, дополнение ADR-040 от 2026-10-29):
// одно сообщение онлайн-участника, которое бот правит на каждую ставку финала.
// Слова те же, что на экране зала: главная цифра — следующая цена, ниже
// текущая ставка и лидер, шаг. Общие у обоих ботов, как слова карточки финала
// (`auction-final.ts`). Строки без точки (дизайн-код, «Карточка лота»).
//
// Роста к стартовой цене здесь нет: снимок лота в торгах стартовой цены не
// несёт, а на экране зала её даёт состояние лота внутри Auction. «К концу
// онлайн-торгов» и время лота — по той же причине.

export const watchStopLabel = "Не следить";
export const watchStoppedLine = "Трансляция остановлена";
export const watchFinishedLine = "Аукцион завершён";
const waitingLine = "Ждём следующий лот";
const unsoldLine = "Не продан";

/** Кого бот называет лидером: имя из Auction, «ты» или «участник» без имени. */
export type BroadcastLeader =
  | { kind: "none" }
  | { kind: "viewer" }
  | { kind: "named"; name: string }
  | { kind: "unnamed" };

export function broadcastLeaderOf(input: {
  leaderId: string | undefined;
  viewerId: string;
  name: string | undefined;
}): BroadcastLeader {
  if (input.leaderId === undefined) return { kind: "none" };
  if (input.leaderId === input.viewerId) return { kind: "viewer" };
  return input.name === undefined
    ? { kind: "unnamed" }
    : { kind: "named", name: input.name };
}

/**
 * Текст трансляции по лоту. Лот в торгах — цена, ставка, лидер и шаг; проданный
 * — итог лота; прочее и отсутствие лота — ожидание следующего.
 */
export function broadcastText(input: {
  lot: LotView | undefined;
  leader: BroadcastLeader;
  // Участник, поставивший выигравшую ставку проданного лота.
  winner: BroadcastLeader;
  // «Обновлено в ЧЧ:ММ:СС» по времени сообщества: застывшая трансляция
  // заметна и без плашки (дополнение ADR-030 от 2026-10-29).
  updatedAt: string;
}): string {
  const { lot } = input;
  const title = lot?.card?.title;
  const head = title === undefined ? [] : [`<b>${escapeHtml(title)}</b>`];
  const foot = `Обновлено в ${input.updatedAt}`;
  if (lot === undefined) return [waitingLine, "", foot].join("\n");
  const { status } = lot;
  if (status.kind === "trading") {
    const next = lot.nextPrice ?? status.currentPrice;
    return [
      ...head,
      "Следующая цена",
      `<b>${formatMoney(next)}</b>`,
      "",
      currentLine(status.currentPrice, input.leader),
      ...(lot.baseStep === undefined
        ? []
        : [`Шаг: +${formatMoney(lot.baseStep)}`]),
      "",
      foot,
    ].join("\n");
  }
  if (status.kind === "sold") {
    return [
      ...head,
      `Продан за ${formatMoney(status.price)}${soldTo(input.winner)}`,
      "",
      waitingLine,
      "",
      foot,
    ].join("\n");
  }
  if (status.kind === "unsold") {
    return [...head, unsoldLine, "", waitingLine, "", foot].join("\n");
  }
  return [...head, waitingLine, "", foot].join("\n");
}

/** Последняя правка конца финала: трансляция больше не обновляется. */
export function broadcastFinishedText(updatedAt: string): string {
  return [watchFinishedLine, "", `Обновлено в ${updatedAt}`].join("\n");
}

function currentLine(price: Money, leader: BroadcastLeader): string {
  // До первой ставки цена лота — стартовая, а не чья-то ставка.
  if (leader.kind === "none") {
    return `Стартовая цена ${formatMoney(price)} · ставок пока нет`;
  }
  const base = `Текущая ставка ${formatMoney(price)}`;
  switch (leader.kind) {
    case "viewer":
      return `${base} · лидируешь ты`;
    case "named":
      return `${base} · лидирует ${escapeHtml(leader.name)}`;
    case "unnamed":
      return `${base} · лидирует другой участник`;
  }
}

function soldTo(winner: BroadcastLeader): string {
  switch (winner.kind) {
    case "viewer":
      return " · тебе";
    case "named":
      return ` · ${escapeHtml(winner.name)}`;
    default:
      return "";
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
