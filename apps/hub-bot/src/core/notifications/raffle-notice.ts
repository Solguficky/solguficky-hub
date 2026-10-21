import type { RaffleResult } from "../../../gen/notifications/v1/notifications_pb.js";

// Итог розыгрыша среди участников (ADR-066, п. 13; PER-620) — весть каждому
// владельцу билета, победителю своя. У двух ботов она одна: участнику её
// доставляет бот хаба, гостю — бот аукциона (ADR-064). Здесь разбор ветки, текст
// и кнопка; данные кнопки каждая поверхность кодирует своим следом, как у вестей
// о лотах.
//
// Права `place-bids` получателя канал перед этой вестью не спрашивает, в отличие
// от вестей о торгах: она о проведённой жеребьёвке, в которой человек уже
// участвовал, — право проверено при регистрации и при закрытии пула, — а
// победителю, у которого право сняли после, о выигрыше знать всё равно нужно:
// выдачу заблокированному решают организаторы (PER-499).

export type RaffleNotice = {
  kind: "raffle-result";
  auctionId: string;
  // Номер билета получателя, от 1 до `ticketCount`.
  ticket: number;
  winningTicket: number;
  ticketCount: number;
  // Приз розыгрыша одной строкой (PER-649); нет — приз не объявлен.
  prize?: string;
};

// Аукцион сходки — UUIDv5, свой аукцион — UUIDv7: версия не проверяется, только
// каноническая форма, из которой кодировщик кнопки соберёт токен.
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Факт — ввод соседа: номер вне 1…N или пустой пул — дефект издателя, и разбор
// отвечает `undefined`, как у остальных веток.
export function raffleNoticeOf(value: RaffleResult): RaffleNotice | undefined {
  const { auctionId, ticket, winningTicket, ticketCount } = value;
  if (!CANONICAL_UUID.test(auctionId) || ticketCount < 1) return undefined;
  const inPool = (number: number) => number >= 1 && number <= ticketCount;
  if (!inPool(ticket) || !inPool(winningTicket)) return undefined;
  return {
    kind: "raffle-result",
    auctionId,
    ticket,
    winningTicket,
    ticketCount,
    // Пустой приз — тот же розыгрыш без приза: строки «Приз:» в вести не будет.
    ...(value.rafflePrize === undefined || value.rafflePrize.trim() === ""
      ? {}
      : { prize: value.rafflePrize.trim() }),
  };
}

// Кнопка следа: экран итога розыгрыша приходит новым сообщением, весть остаётся
// в истории.
export type RaffleNoticeButton = { auctionId: string; text: string };

export type RaffleNoticeView = { text: string; button: RaffleNoticeButton };

const toRaffleLabel = "К розыгрышу";

// Одна фраза на «ты», без заголовка и разметки (дизайн-код, «Уведомления
// аукциона»). Имени победителя весть не несёт — его нет в факте: оно на экране
// итога по кнопке. Приз назван в той же фразе, и следующий шаг тоже (PER-649):
// выдачу ведёт организатор вне бота, и бот обещает только его сообщение.
export function renderRaffleNotice(notice: RaffleNotice): RaffleNoticeView {
  const { ticket, winningTicket, ticketCount, prize } = notice;
  return {
    text:
      ticket === winningTicket
        ? prize === undefined
          ? `Твой билет №${ticket} из ${ticketCount} выиграл розыгрыш среди участников.`
          : `Твой билет №${ticket} из ${ticketCount} выиграл розыгрыш среди участников: приз — ${prize}, а организатор напишет тебе, как его получить.`
        : `Розыгрыш среди участников проведён: выиграл билет №${winningTicket} из ${ticketCount}, твой — №${ticket}.`,
    button: { auctionId: notice.auctionId, text: toRaffleLabel },
  };
}
