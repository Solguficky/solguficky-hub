import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { RaffleResultSchema } from "../../../gen/notifications/v1/notifications_pb.js";
import {
  type RaffleNotice,
  raffleNoticeOf,
  renderRaffleNotice,
} from "./raffle-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";

const result = (ticket: number, winningTicket = 7, ticketCount = 12) =>
  create(RaffleResultSchema, { auctionId, ticket, winningTicket, ticketCount });

describe("raffleNoticeOf", () => {
  it("carries the auction, the recipient's ticket and the pool", () => {
    expect(raffleNoticeOf(result(3))).toEqual({
      kind: "raffle-result",
      auctionId,
      ticket: 3,
      winningTicket: 7,
      ticketCount: 12,
    });
  });

  // Приз розыгрыша (PER-649) едет фактом и обрезается по краям; пустая строка —
  // розыгрыш без приза.
  it("carries the raffle prize and drops a blank one", () => {
    expect(
      raffleNoticeOf(
        create(RaffleResultSchema, {
          auctionId,
          ticket: 3,
          winningTicket: 7,
          ticketCount: 12,
          rafflePrize: "  сертификат на 5000 ₽ ",
        }),
      ),
    ).toMatchObject({ prize: "сертификат на 5000 ₽" });
    expect(
      raffleNoticeOf(
        create(RaffleResultSchema, {
          auctionId,
          ticket: 3,
          winningTicket: 7,
          ticketCount: 12,
          rafflePrize: "  ",
        }),
      ),
    ).not.toHaveProperty("prize");
  });

  // Номер вне 1…N, пустой пул и не каноническая форма аукциона — дефект
  // издателя: кнопку из такого факта не собрать, текст был бы неправдой.
  it.each([
    ["a ticket outside the pool", result(13)],
    ["a winning ticket outside the pool", result(3, 0)],
    ["an empty pool", result(1, 1, 0)],
    [
      "an auction id not in canonical form",
      create(RaffleResultSchema, {
        auctionId: auctionId.toUpperCase(),
        ticket: 1,
        winningTicket: 1,
        ticketCount: 1,
      }),
    ],
  ])("rejects %s", (_, value) => {
    expect(raffleNoticeOf(value)).toBeUndefined();
  });
});

describe("renderRaffleNotice", () => {
  const notice = (
    ticket: number,
    ticketCount = 12,
    prize?: string,
  ): RaffleNotice => ({
    kind: "raffle-result",
    auctionId,
    ticket,
    winningTicket: ticket === 3 ? 7 : ticket,
    ticketCount,
    ...(prize === undefined ? {} : { prize }),
  });

  it("tells the winner their ticket won", () => {
    expect(renderRaffleNotice(notice(7)).text).toBe(
      "Твой билет №7 из 12 выиграл розыгрыш среди участников.",
    );
  });

  // Приз называет себя в вести победителя (PER-649): его задаёт пульт, а
  // участники видят ту же строку на экране розыгрыша.
  it("names the prize and the next step to the winner", () => {
    expect(renderRaffleNotice(notice(7, 12, "сертификат на 5000 ₽")).text).toBe(
      "Твой билет №7 из 12 выиграл розыгрыш среди участников: приз — сертификат на 5000 ₽, а организатор напишет тебе, как его получить.",
    );
  });

  // Приза нет — весть остаётся прежней: ни приза, ни обещания выдачи.
  it("tells the winner without a prize when the raffle has no prize", () => {
    const text = renderRaffleNotice(notice(7)).text;
    expect(text).not.toContain("приз");
    expect(text).not.toContain("как его получить");
  });

  // Единственный билет выигрывает так же: жеребьёвка его не пропускает.
  it("tells the only ticket holder their ticket won", () => {
    expect(renderRaffleNotice(notice(1, 1)).text).toBe(
      "Твой билет №1 из 1 выиграл розыгрыш среди участников.",
    );
  });

  it("names the winning ticket and the recipient's own to the others", () => {
    expect(renderRaffleNotice(notice(3))).toEqual({
      text: "Розыгрыш среди участников проведён: выиграл билет №7 из 12, твой — №3.",
      button: { auctionId, text: "К розыгрышу" },
    });
  });
});
