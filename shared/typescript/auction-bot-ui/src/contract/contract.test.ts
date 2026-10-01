import { describe, expect, it } from "vitest";
import { type AuctionSurface, handleAuctionUpdate } from "../gateway.js";
import {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  CONTRACT_IDENTITY,
  CONTRACT_LOT,
  checkAuctionContract,
  describeAuctionContract,
} from "./index.js";

// Фабрики-заглушки двух поверхностей: вход доведён ровно до шлюза, как его
// доведут приложения, — личность разрешается один раз и уходит в update.
const stubApp =
  (kind: AuctionSurface["kind"]): AuctionContractApp =>
  (ports) =>
  async ({ from, input }) =>
    handleAuctionUpdate(
      { kind, ports },
      { identity: await ports.identity.resolveIdentity(from), input },
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
        lotId: "01929b7e-5c1d-7a3f-8e4b-ffffffffffff",
      });
      return stubApp("auction")({
        ...ports,
        auction: { getLot: async () => CONTRACT_LOT },
      })(update);
    };
    const violations = await checkAuctionContract(wrongIntent);
    expect(violations.map((v) => [v.intent, v.kind])).toEqual([
      ["lot", "wrong-port-call"],
    ]);
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
    const kinds = (await checkAuctionContract(drifted)).map((v) => v.kind);
    expect(kinds).toEqual(["wrong-callback-data", "wrong-body"]);
  });

  // Второй вызов — то, что сделал бы шлюз, разрешающий личность сам.
  it("fails when identity is resolved twice for one update", async () => {
    const twice: AuctionContractApp = (ports) => async (pressed) => {
      await ports.identity.resolveIdentity(pressed.from);
      return stubApp("hub")(ports)(pressed);
    };
    const kinds = (await checkAuctionContract(twice)).map((v) => v.kind);
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app resolves someone other than the presser", async () => {
    const wrongUser: AuctionContractApp = (ports) => async (pressed) =>
      stubApp("hub")(ports)({ ...pressed, from: { telegramUserId: 1 } });
    const kinds = (await checkAuctionContract(wrongUser)).map((v) => v.kind);
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app skips the Identity port", async () => {
    const skipping: AuctionContractApp =
      (ports) =>
      async ({ input }) =>
        handleAuctionUpdate(
          { kind: "hub", ports },
          { identity: CONTRACT_IDENTITY, input },
        );
    const kinds = (await checkAuctionContract(skipping)).map((v) => v.kind);
    expect(kinds).toEqual(["identity-not-resolved-once"]);
  });

  it("fails when the app denies instead of showing the screen", async () => {
    const denying: AuctionContractApp = () => async () => ({
      kind: "denied",
      reason: "not-admitted",
    });
    const kinds = (await checkAuctionContract(denying)).map((v) => v.kind);
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
    expect(AUCTION_CONTRACT_CASES.map((c) => c.intent)).toEqual(["lot"]);
  });
});
