import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  type OnlinePhase,
  OnlinePhaseSchema,
} from "../../../gen/auction/v1/auction_pb.js";
import {
  AuctionPublishedSchema,
  AuctionTradingOpenedSchema,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  newAuctionNoticeOf,
  renderAuctionAnnouncement,
  tradingOpenedNoticeOf,
} from "./auction-announcement-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
const meetupId = "0190f3a4-5b6c-7d8e-9f01-23456789abcd";

const week = (opensAt: string, closesAt?: string): OnlinePhase =>
  create(OnlinePhaseSchema, {
    opensAt,
    ...(closesAt === undefined ? {} : { closesAt }),
  });

const published = (phase?: OnlinePhase, title = "Пятничная") =>
  create(AuctionPublishedSchema, {
    auctionId,
    meetupId,
    meetupTitle: title,
    onlinePhase: phase,
  });

const started = (phase?: OnlinePhase) =>
  create(AuctionTradingOpenedSchema, {
    auctionId,
    meetupId,
    meetupTitle: "Пятничная",
    onlinePhase: phase,
  });

describe("newAuctionNoticeOf", () => {
  it("carries the auction, the meetup title and the week", () => {
    expect(
      newAuctionNoticeOf(
        published(week("2026-10-20T09:00:00Z", "2026-10-26T20:00:00Z")),
      ),
    ).toEqual({
      kind: "new-auction",
      auctionId,
      meetupTitle: "Пятничная",
      opensAt: "2026-10-20T09:00:00Z",
      closesAt: "2026-10-26T20:00:00Z",
    });
  });

  // Черновик недели не имеет: поля нет, а не пустая строка.
  it("has no week on a draft", () => {
    expect(newAuctionNoticeOf(published())).toEqual({
      kind: "new-auction",
      auctionId,
      meetupTitle: "Пятничная",
    });
  });

  // Пустая строка — отсутствие поля: открытие без назначенного конца.
  it("drops an empty instant", () => {
    expect(newAuctionNoticeOf(published(week("")))).toEqual({
      kind: "new-auction",
      auctionId,
      meetupTitle: "Пятничная",
    });
  });

  it("answers undefined on a broken auction id", () => {
    expect(
      newAuctionNoticeOf(create(AuctionPublishedSchema, { auctionId: "nope" })),
    ).toBeUndefined();
  });
});

describe("tradingOpenedNoticeOf", () => {
  it("carries the deadline of the week", () => {
    expect(
      tradingOpenedNoticeOf(
        started(week("2026-10-20T09:00:00Z", "2026-10-26T20:00:00Z")),
      ),
    ).toEqual({
      kind: "trading-opened",
      auctionId,
      meetupTitle: "Пятничная",
      opensAt: "2026-10-20T09:00:00Z",
      closesAt: "2026-10-26T20:00:00Z",
    });
  });

  it("answers undefined on a broken auction id", () => {
    expect(
      tradingOpenedNoticeOf(
        create(AuctionTradingOpenedSchema, { auctionId: "nope" }),
      ),
    ).toBeUndefined();
  });
});

describe("renderAuctionAnnouncement", () => {
  it("names the meetup and the week by the community clock", () => {
    const view = renderAuctionAnnouncement(
      newAuctionNoticeOf(
        published(week("2026-10-20T09:00:00Z", "2026-10-26T20:00:00Z")),
      )!,
      "Europe/Moscow",
    );
    expect(view.text).toBe(
      "Аукцион сходки «Пятничная» открыт: торги с 20 октября, 12:00 по 26 октября, 23:00.",
    );
    expect(view.button).toEqual({ auctionId, text: "Аукцион" });
  });

  it("promises the dates when the auction is published before its week", () => {
    expect(
      renderAuctionAnnouncement(newAuctionNoticeOf(published())!, "UTC"),
    ).toEqual({
      text: "Аукцион сходки «Пятничная» открыт: сроки объявлю, когда их назначат.",
      button: { auctionId, text: "Аукцион" },
    });
  });

  it("names no meetup when the replica knows it by its id alone", () => {
    expect(
      renderAuctionAnnouncement(
        newAuctionNoticeOf(published(undefined, ""))!,
        "UTC",
      ).text,
    ).toBe("Аукцион сходки открыт: сроки объявлю, когда их назначат.");
  });

  it("names the deadline of the opened week", () => {
    expect(
      renderAuctionAnnouncement(
        tradingOpenedNoticeOf(
          started(week("2026-10-20T09:00:00Z", "2026-10-26T20:00:00Z")),
        )!,
        "UTC",
      ),
    ).toEqual({
      text: "Торги открыты: неделя идёт до 26 октября, 20:00.",
      button: { auctionId, text: "Лоты" },
    });
  });

  // Неделя, кончающаяся командой, дедлайна не имеет: весть его не выдумывает.
  it("names no deadline when the week ends on a command", () => {
    expect(
      renderAuctionAnnouncement(
        tradingOpenedNoticeOf(started(week("2026-10-20T09:00:00Z")))!,
        "UTC",
      ).text,
    ).toBe("Торги открыты.");
  });

  // Непонятный момент — пусто, а не полночь: весть не выдумывает времени.
  it("skips an instant it cannot read", () => {
    expect(
      renderAuctionAnnouncement(
        newAuctionNoticeOf(published(week("not-a-moment")))!,
        "UTC",
      ).text,
    ).toBe(
      "Аукцион сходки «Пятничная» открыт: сроки объявлю, когда их назначат.",
    );
  });
});
