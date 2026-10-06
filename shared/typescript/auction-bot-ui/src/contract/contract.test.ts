import { describe, expect, it } from "vitest";
import { type AuctionSurface, handleAuctionUpdate } from "../gateway.js";
import {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  type AuctionContractCase,
  CONTRACT_IDENTITY,
  CONTRACT_LOT,
  CONTRACT_USER,
  checkAuctionContract,
  checkAuctionContractCase,
  describeAuctionContract,
} from "./index.js";

// Намерение карточки лота в торгах: на нём самопроверки ниже ловят дрейф
// одного вызова, а не восьми сразу.
const LOT_CASE = caseOf("lot: trading");

function caseOf(intent: string): AuctionContractCase {
  const found = AUCTION_CONTRACT_CASES.find((c) => c.intent === intent);
  if (found === undefined) throw new Error(`no contract case ${intent}`);
  return found;
}

// Фабрики-заглушки двух поверхностей: вход доведён ровно до шлюза, как его
// доведут приложения, — личность разрешается один раз и уходит в update.
const stubApp =
  (kind: AuctionSurface["kind"]): AuctionContractApp =>
  (ports) =>
  async ({ from, input }) =>
    handleAuctionUpdate(
      { kind, ports },
      {
        identity: await ports.identity.resolveIdentity(from),
        user: from,
        input,
      },
    );

describeAuctionContract("hub stub", stubApp("hub"));
describeAuctionContract("auction stub", stubApp("auction"));

describe("auction contract self-check", () => {
  it("passes over the stub factories", async () => {
    expect(await checkAuctionContract(stubApp("hub"))).toEqual([]);
    expect(await checkAuctionContract(stubApp("auction"))).toEqual([]);
  });

  // Заглушка, которая зовёт порт не с тем намерением: просит у Auction другой
  // лот. Тело при этом совпадает, поэтому ловит её именно сравнение вызова.
  it("fails when the port is called with another intent", async () => {
    const wrongIntent: AuctionContractApp = (ports) => async (update) => {
      await ports.auction.getLot({
        viewer: { identityId: "someone-else", globalRoles: ["public"] },
        lotId: CONTRACT_LOT.lotId,
      });
      return stubApp("auction")({
        ...ports,
        auction: { ...ports.auction, getLot: async () => CONTRACT_LOT },
      })(update);
    };
    const violations = await checkAuctionContractCase(wrongIntent, LOT_CASE);
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
        viewer: { identityId: CONTRACT_IDENTITY.identityId, globalRoles: [] },
        lotId: "01929b7e-5c1d-7a3f-8e4b-ffffffffffff",
      });
      throw new Error("unreachable");
    };
    const kinds = (await checkAuctionContractCase(lost, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["wrong-port-call", "app-threw"]);
  });

  it("fails when the canonical body or its buttons drift", async () => {
    const drifted: AuctionContractApp = (ports) => async (update) => {
      const result = await stubApp("hub")(ports)(update);
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
    const kinds = (await checkAuctionContractCase(drifted, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["wrong-callback-data", "wrong-body"]);
  });

  // Второй вызов — то, что сделал бы шлюз, разрешающий личность сам.
  it("fails when identity is resolved twice for one update", async () => {
    const twice: AuctionContractApp = (ports) => async (pressed) => {
      await ports.identity.resolveIdentity(pressed.from);
      return stubApp("hub")(ports)(pressed);
    };
    const kinds = (await checkAuctionContractCase(twice, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app resolves someone other than the presser", async () => {
    const wrongUser: AuctionContractApp = (ports) => async (pressed) =>
      stubApp("hub")(ports)({ ...pressed, from: { telegramUserId: 1 } });
    const kinds = (await checkAuctionContractCase(wrongUser, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app skips the Identity port", async () => {
    const skipping: AuctionContractApp =
      (ports) =>
      async ({ input }) =>
        handleAuctionUpdate(
          { kind: "hub", ports },
          { identity: CONTRACT_IDENTITY, user: CONTRACT_USER, input },
        );
    const kinds = (await checkAuctionContractCase(skipping, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app denies instead of showing the screen", async () => {
    const denying: AuctionContractApp = () => async () => ({
      kind: "denied",
      reason: "not-admitted",
    });
    const kinds = (await checkAuctionContractCase(denying, LOT_CASE)).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual([
      "identity-not-resolved-once",
      "wrong-port-call",
      "not-a-screen",
    ]);
  });

  it("treats an empty intent table as a violation", async () => {
    expect(await checkAuctionContract(stubApp("hub"), [])).toEqual([
      { intent: "*", kind: "no-cases", detail: "intent table is empty" },
    ]);
  });

  it("checks every intent of the table", () => {
    expect(AUCTION_CONTRACT_CASES.map((c) => c.intent)).toEqual([
      "feed",
      "feed: stale page",
      "feed: empty",
      "lot: trading",
      "lot: sold",
      "lot: unsold",
      "lot: withdrawn",
      "lot: names unavailable",
      "lot: scheduled",
      "lot: held",
      "lot: draft",
      "history: newest page",
      "history: earlier page",
      "history: names unavailable",
      "history: empty",
      "bid: confirm the step",
      "bid: accepted",
      "bid: step refused to the leader before the confirmation",
      "bid: refused below the minimum",
      "bid: refused to the leader",
      "bid: unanswered, then accepted",
      "bid: unanswered twice",
      "bid: name not chosen",
      "name: use the username",
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
      "proxy: answer the limit",
      "proxy: accepted",
      "proxy: refused below the current price",
    ]);
  });
});
