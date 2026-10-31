import { describe, expect, it } from "vitest";
import { handleAuctionUpdate } from "../gateway.js";
import {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  type AuctionContractCase,
  CONTRACT_LOT,
  CONTRACT_USER,
  CONTRACT_VIEWER,
  checkAuctionContract,
  checkAuctionContractCase,
  contractIdentity,
} from "./index.js";
import { auctionContractApp } from "./surfaces.js";

// Намерение карточки лота в торгах: на нём самопроверки ниже ловят дрейф
// одного вызова, а не восьми сразу.
const LOT_CASE = caseOf("lot: trading");

function caseOf(intent: string): AuctionContractCase {
  const found = AUCTION_CONTRACT_CASES.find((c) => c.intent === intent);
  if (found === undefined) throw new Error(`no contract case ${intent}`);
  return found;
}

// Самопроверки идут над той же фабрикой, что и suite поверхностей
// (`surfaces.test.ts`).
const appOf = auctionContractApp;

describe("auction contract self-check", () => {
  it("passes over the surface factories", async () => {
    expect(await checkAuctionContract("hub", appOf("hub"))).toEqual([]);
    expect(await checkAuctionContract("auction", appOf("auction"))).toEqual([]);
  });

  // Заглушка, которая зовёт порт не с тем намерением: просит у Auction другой
  // лот. Тело при этом совпадает, поэтому ловит её именно сравнение вызова.
  it("fails when the port is called with another intent", async () => {
    const wrongIntent: AuctionContractApp = (ports) => async (update) => {
      await ports.auction.getLot({
        viewer: { identityId: "someone-else", rights: ["place-bids"] },
        lotId: CONTRACT_LOT.lotId,
      });
      return appOf("auction")({
        ...ports,
        auction: { ...ports.auction, getLot: async () => CONTRACT_LOT },
      })(update);
    };
    const violations = await checkAuctionContractCase(
      "auction",
      wrongIntent,
      LOT_CASE,
    );
    expect(violations.map((v) => [v.intent, v.kind])).toEqual([
      ["lot: trading", "wrong-port-call"],
    ]);
  });

  // Заглушка, которая теряет права смотрящего: тот же человек и тот же лот,
  // но Auction без прав отказал бы ему (ADR-064, пункт 6).
  it("fails when the viewer reaches Auction without its rights", async () => {
    const rightless: AuctionContractApp = (ports) =>
      appOf("auction")({
        ...ports,
        auction: {
          ...ports.auction,
          getLot: (request) =>
            ports.auction.getLot({
              ...request,
              viewer: { ...request.viewer, rights: [] },
            }),
        },
      });
    const violations = await checkAuctionContractCase(
      "auction",
      rightless,
      LOT_CASE,
    );
    expect(violations.map((v) => [v.intent, v.kind])).toEqual([
      ["lot: trading", "wrong-port-call"],
    ]);
  });

  // Приложение спросило лот, которого в снимке нет: шпион падает, и это
  // нарушение намерения, а не сломанный прогон.
  it("reports an app that throws on the spy answer", async () => {
    const lost: AuctionContractApp = (ports) => async () => {
      await ports.identity.resolveIdentity({ telegramUserId: 424242 });
      await ports.auction.getLot({
        viewer: CONTRACT_VIEWER,
        lotId: "01929b7e-5c1d-7a3f-8e4b-ffffffffffff",
      });
      throw new Error("unreachable");
    };
    const kinds = (await checkAuctionContractCase("hub", lost, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["wrong-port-call", "app-threw"]);
  });

  it("fails when the canonical body or its buttons drift", async () => {
    const drifted: AuctionContractApp = (ports) => async (update) => {
      const result = await appOf("hub")(ports)(update);
      if (result.kind !== "screen") return result;
      return {
        kind: "screen",
        body: {
          ...result.body,
          keyboard: [
            [{ action: "lot.refresh", callbackData: "v1:auc:lot:stale" }],
          ],
        },
      };
    };
    const kinds = (
      await checkAuctionContractCase("hub", drifted, LOT_CASE)
    ).map((v) => v.kind);
    expect(kinds).toEqual(["wrong-callback-data", "wrong-body"]);
  });

  // Второй вызов — то, что сделал бы шлюз, разрешающий личность сам.
  it("fails when identity is resolved twice for one update", async () => {
    const twice: AuctionContractApp = (ports) => async (pressed) => {
      await ports.identity.resolveIdentity(pressed.from);
      return appOf("hub")(ports)(pressed);
    };
    const kinds = (await checkAuctionContractCase("hub", twice, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app resolves someone other than the presser", async () => {
    const wrongUser: AuctionContractApp = (ports) => async (pressed) =>
      appOf("hub")(ports)({ ...pressed, from: { telegramUserId: 1 } });
    const kinds = (
      await checkAuctionContractCase("hub", wrongUser, LOT_CASE)
    ).map((v) => v.kind);
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app skips the Identity port", async () => {
    const skipping: AuctionContractApp =
      (ports) =>
      async ({ input }) =>
        handleAuctionUpdate(
          { kind: "hub", ports },
          { identity: contractIdentity("hub"), user: CONTRACT_USER, input },
        );
    const kinds = (
      await checkAuctionContractCase("hub", skipping, LOT_CASE)
    ).map((v) => v.kind);
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app denies instead of showing the screen", async () => {
    const denying: AuctionContractApp = () => async () => ({
      kind: "denied",
      reason: "not-admitted",
    });
    const kinds = (
      await checkAuctionContractCase("hub", denying, LOT_CASE)
    ).map((v) => v.kind);
    expect(kinds).toEqual([
      "identity-not-resolved-once",
      "wrong-port-call",
      "not-a-screen",
    ]);
  });

  it("treats an empty intent table as a violation", async () => {
    expect(await checkAuctionContract("hub", appOf("hub"), [])).toEqual([
      { intent: "*", kind: "no-cases", detail: "intent table is empty" },
    ]);
  });

  it("checks every intent of the table", () => {
    expect(AUCTION_CONTRACT_CASES.map((c) => c.intent)).toEqual([
      "lot: the card of a lot of a set",
      "set: the screen of the set",
      "achievements: empty event set",
      "achievements: event set",
      "root: with a raffle",
      "root: cancelled auction keeps the raffle",
      "root: raffle read refused",
      "root: predictions read forbidden",
      "root: predictions read unavailable",
      "root: with favorites",
      "root: auction not given",
      "root: promo video with the media chat",
      "root: promo video without the media chat",
      "promo: the post of the auction",
      "promo: the video was taken back",
      "promo: without the media chat",
      "root: finished auction offers the auction results",
      "day chronicle: nominations of the last day",
      "day chronicle: no bids in the last day",
      "day chronicle: no lots",
      "day chronicle: bids without a nominee",
      "feed",
      "feed: stale page",
      "feed: empty",
      "feed: sections",
      "section",
      "feed: before trading",
      "lot: trading",
      "lot: trading, led by the viewer",
      "lot: after an accepted command while the read model lags",
      "lot: after an accepted command when the read model does not catch up",
      "lot: sold",
      "lot: unsold",
      "lot: withdrawn",
      "lot: names unavailable",
      "lot: scheduled",
      "lot: scheduled, step by thresholds",
      "lot: held",
      "lot: held with proxy",
      "lot: held with own limit",
      "withdraw: confirm",
      "withdraw: confirm without a limit",
      "withdraw: accepted",
      "withdraw: no limit left",
      "lot: draft",
      "history: newest page",
      "history: earlier page",
      "history: names unavailable",
      "history: empty",
      "bid: confirm the step",
      "bid: name asked before the confirmation",
      "bid: name read refused, confirmation shown",
      "bid: accepted",
      "bid: accepted, lead kept",
      "bid: accepted, overtaken by a proven proxy",
      "bid: accepted, overtaken by a floor bid",
      "bid: accepted, overtaken origin ambiguous",
      "bid: accepted without a version",
      "bid: step refused to the leader before the confirmation",
      "bid: refused below the minimum",
      "bid: refused to a participant removed from the lot",
      "bid: refused to the leader",
      "bid: unanswered, then accepted",
      "bid: unanswered twice",
      "bid: name not chosen",
      "name: use the username",
      "name: frozen meanwhile, confirmation shown",
      "name: alias taken",
      "bid: ask the amount",
      "bid: answer the amount",
      "bid: answer below the minimum",
      "bid: answer from the leader",
      "bid: answer not a number",
      "bid: answer in another currency",
      "bid: answer not in text",
      "bid: cancel the question",
      "proxy: ask the limit",
      "proxy: ask the limit before the first one",
      "proxy: ask the limit again",
      "proxy: ask the limit, mark unavailable",
      "proxy: how it works",
      "proxy: answer the limit",
      "proxy: accepted",
      "proxy: accepted, explainer marked",
      "proxy: accepted, mark unavailable",
      "proxy: refused below the current price",
      "final: card",
      "final: watch",
      "final: bid accepted",
      "final: bid at a price that moved",
      "final: bid unanswered twice",
      "final: bid without a chosen name",
      "final: name chosen places the pending bid",
      "final: name chosen after the price moved",
      "final: name chosen for a week bid returns to the card",
      "final: stale button outside the final",
      "lot: in favorites",
      "lot: sold, in favorites",
      "lot: not in favorites",
      "lot: closed, not in favorites",
      "lot: favorites unavailable",
      "follow: marked",
      "follow: lot not known yet",
      "unfollow",
      "favorites: from the menu",
      "favorites: from the root",
      "favorites: from the root of a finished auction",
      "favorites: finished auction, lots of another",
      "favorites: empty",
      "lot: neighbors across a feed page",
      "lot: last in the feed",
      "lot: first in the feed",
      "lot: alone in the feed",
      "lot: feed unavailable",
      "feed: the raffle stays in the root",
      "raffle: open",
      "raffle: open, winner by hand",
      "raffle: closing, winner by hand",
      "raffle: registered",
      "raffle: drawn",
      "raffle: absent",
      "raffle: cancelled",
      "raffle: register after the cancellation",
      "raffle: proof before the draw",
      "raffle: proof after the draw",
      "raffle: proof of a cancelled raffle",
      "raffle: proof without a raffle",
      "raffle: register",
      "raffle: register unanswered",
      "raffle: register after closing",
      "raffle: register without a name",
      "raffle: cancel",
      "raffle: username",
      "raffle: ask alias",
      "raffle: alias question cancelled",
      "raffle: alias answered",
      "raffle: alias taken",
      "raffle: alias not text",
      "name settings: not chosen",
      "name settings: chosen, not frozen",
      "name settings: frozen",
      "name settings: username",
      "name settings: same name after the freeze",
      "name settings: frozen meanwhile",
      "name settings: ask alias",
      "name settings: alias taken",
      "feed: the viewer leads",
      "lot: sold to the viewer",
      "bid: accepted with favorites",
      "bid: accepted on a lot already in favorites",
      "bid: accepted, favorites unavailable",
      "bid: accepted, extended by anti-sniping",
      "bid: accepted, not extended",
      "bid: accepted, no extensions left",
      "predictions: root opens the active final round",
      "predictions: root offers the catalog round during online trading",
      "predictions: open catalog round with only own answers",
      "predictions: mark a removed catalog lot in the open forecast",
      "predictions: switch to unopened final round",
      "predictions: closed round is read-only",
      "predictions: counted results inside the closed round",
      "predictions: results counted by hand inside the closed round",
      "predictions: the old results button opens the tab",
      "predictions: reject a stale answer after round closure",
      "predictions: honor round-closed refusal despite a stale open read",
      "predictions: edit catalog lot from all catalog lots",
      "predictions: edit final lot from held lineup only",
      "predictions: reopen catalog lot choices from pagination callback",
      "predictions: select final lot",
      "predictions: parse rubles and preserve other nominations",
      "predictions: remove a withdrawn answer before saving another nomination",
      "predictions: parse grouped integer in final round",
      "predictions: reject foreign currency code",
      "predictions: clear one nomination and keep the rest",
      "predictions: unanswered submission retries same operation",
      "predictions: unanswered twice shows an uncertain save outcome",
      "predictions: ask for the name before the answer",
      "predictions: own name read refused still asks the answer",
      "predictions: ask for a name without losing the nomination",
      "predictions: choose username returns to same nomination",
      "predictions: ask for an alias",
      "predictions: alias question cancelled",
      "predictions: alias reply without text can be retried",
      "predictions: ask and answer alias with same context",
      "root: with the invoices of the winner",
      "my invoices: the invoices of the winner with the organizer's text",
      "my invoice: an invoice with the organizer's text and no choice",
      "my invoice: an invoice of someone else is not found",
    ]);
  });
});
