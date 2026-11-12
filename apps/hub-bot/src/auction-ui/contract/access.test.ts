import { describe, expect, it } from "vitest";
import {
  ACCESS_MATRIX_CASES,
  type AccessMatrixApp,
  type AccessMatrixCase,
  CONTRACT_LOT,
  checkAccessMatrix,
  checkAccessMatrixCase,
} from "./index.js";
import { accessMatrixApp } from "./surfaces.js";

function caseOf(name: string): AccessMatrixCase {
  const found = ACCESS_MATRIX_CASES.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no matrix case ${name}`);
  return found;
}

// Самопроверки идут над той же фабрикой, что и матрица поверхностей
// (`surfaces.test.ts`).
const appOf = accessMatrixApp;

describe("access matrix self-check", () => {
  const kindsOf = async (app: AccessMatrixApp, name: string) =>
    (await checkAccessMatrixCase(app, caseOf(name))).map((v) => v.kind);

  it("passes over the surface factories", async () => {
    expect(await checkAccessMatrix("hub", appOf("hub"))).toEqual([]);
    expect(await checkAccessMatrix("auction", appOf("auction"))).toEqual([]);
  });

  // Вход, каким он был до PER-592: `/start` ставит заявку без намерения
  // человека, а не разрешает личность.
  it("fails when /start applies instead of resolving the identity", async () => {
    const applying: AccessMatrixApp = (ports) => (input) =>
      appOf("hub")(ports)(
        input.action.kind === "start"
          ? { ...input, action: { ...input.action, kind: "apply" } }
          : input,
      );
    expect(await kindsOf(applying, "hub: newcomer starts")).toEqual([
      "wrong-identity-calls",
      "wrong-answer",
    ]);
  });

  it("fails when the surface applies to another queue", async () => {
    const wrongQueue: AccessMatrixApp = (ports) => (input) =>
      appOf("hub")({
        ...ports,
        entry: {
          requestAccess: (request) =>
            ports.entry.requestAccess({ ...request, queue: "auction" }),
        },
      })(input);
    expect(await kindsOf(wrongQueue, "hub: newcomer applies")).toEqual([
      "wrong-identity-calls",
    ]);
  });

  it("fails when the channel code does not reach Identity", async () => {
    const dropping: AccessMatrixApp = (ports) => (input) =>
      appOf("auction")(ports)({ ...input, action: { kind: "apply" } });
    expect(await kindsOf(dropping, "auction: newcomer applies")).toEqual([
      "wrong-identity-calls",
    ]);
  });

  it("fails when a denied person reaches Auction", async () => {
    const eager: AccessMatrixApp = (ports) => async (input) => {
      await ports.auction.getLot({
        viewer: { identityId: "anyone", rights: [] },
        lotId: CONTRACT_LOT.lotId,
      });
      return appOf("auction")(ports)(input);
    };
    expect(await kindsOf(eager, "auction: newcomer presses")).toEqual([
      "auction-reached",
    ]);
  });

  // Адаптер, который отвечает «пустили» и ничего не читает: без этой
  // проверки матрица зелёная над приложением, которое забыло Auction.
  it("fails when an admitted press never reaches Auction", async () => {
    const idle: AccessMatrixApp = (ports) => async (input) => {
      if (input.action.kind !== "callback") return appOf("hub")(ports)(input);
      await ports.identity.resolveIdentity(input.from);
      return "admitted";
    };
    expect(await kindsOf(idle, "hub: hub right presses")).toEqual([
      "auction-not-reached",
    ]);
  });

  // Повторная заявка обязана ответить как первая: приложение, которое
  // запомнило человека и на второй раз отказало, матрицу не проходит.
  it("fails when a repeated application answers differently", async () => {
    const forgetful: AccessMatrixApp = (ports) => {
      const act = appOf("hub")(ports);
      let seen = false;
      return async (input) => {
        const answer = await act(input);
        if (seen) return "declined";
        seen = true;
        return answer;
      };
    };
    const violations = await checkAccessMatrixCase(
      forgetful,
      caseOf("hub: newcomer applies"),
    );
    expect(violations.map((v) => v.kind)).toEqual(["wrong-answer"]);
    expect(violations[0]?.detail).toContain('"attempt":2');
  });

  it("fails when the second update skips Identity", async () => {
    const caching: AccessMatrixApp = (ports) => {
      const act = appOf("auction")(ports);
      let cached: Awaited<ReturnType<typeof act>> | undefined;
      return async (input) => {
        cached ??= await act(input);
        return cached;
      };
    };
    const violations = await checkAccessMatrixCase(
      caching,
      caseOf("auction: newcomer starts"),
    );
    expect(violations.map((v) => v.kind)).toEqual(["wrong-identity-calls"]);
    expect(violations[0]?.detail).toContain('"attempt":2');
  });

  // Бот аукциона, который пускает участника к торгам, как раньше пускал
  // `public`: подделанное нажатие дошло бы до Auction.
  it("fails when the auction bot lets a member trade", async () => {
    const lenient: AccessMatrixApp = (ports) => (input) =>
      appOf("auction")({
        ...ports,
        identity: {
          resolveIdentity: async (user) => {
            const resolved = await ports.identity.resolveIdentity(user);
            return {
              ...resolved,
              viewer: { ...resolved.viewer, rights: ["place-bids"] },
            };
          },
        },
      })(input);
    expect(await kindsOf(lenient, "auction: hub right presses")).toEqual([
      "auction-reached",
      "wrong-answer",
    ]);
  });

  it("fails when the blocked get the answer of the pending", async () => {
    const flattening: AccessMatrixApp = (ports) => async (input) => {
      const answer = await appOf("hub")(ports)(input);
      return answer === "blocked" ? "pending" : answer;
    };
    expect(await kindsOf(flattening, "hub: blocked presses")).toEqual([
      "wrong-answer",
    ]);
    expect(await kindsOf(flattening, "hub: blocked starts")).toEqual([
      "wrong-answer",
    ]);
  });

  it("fails when an unknown outcome enters by the rights", async () => {
    const trusting: AccessMatrixApp = (ports) => async (input) => {
      const answer = await appOf("hub")(ports)(input);
      return answer === "unavailable" ? "admitted" : answer;
    };
    expect(await kindsOf(trusting, "hub: unknown outcome")).toEqual([
      "wrong-answer",
    ]);
  });

  it("reports an app that throws", async () => {
    const broken: AccessMatrixApp = () => async () => {
      throw new Error("boom");
    };
    expect(await kindsOf(broken, "hub: hub right starts")).toEqual([
      "wrong-identity-calls",
      "app-threw",
    ]);
  });

  it("treats a surface without cases as a violation", async () => {
    const auctionOnly = ACCESS_MATRIX_CASES.filter(
      (each) => each.surface === "auction",
    );
    expect(await checkAccessMatrix("hub", appOf("hub"), auctionOnly)).toEqual([
      { case: "*", kind: "no-cases", detail: "no cases for hub" },
    ]);
  });

  it("checks every row of the matrix", () => {
    expect(ACCESS_MATRIX_CASES.map((each) => each.name)).toEqual([
      "hub: member presses achievement set",
      "auction: guest presses achievement set",
      "auction: admin presses achievement set",
      "auction: community member presses achievement set",
      "auction: newcomer presses achievement set",
      "auction: blocked presses achievement set",
      "hub: hub right starts",
      "hub: hub right presses",
      "hub: member presses the statistics",
      "hub: host presses the statistics",
      "hub: allowlisted applies",
      "hub: auction right only starts",
      "hub: auction right only presses",
      "hub: auction right only applies",
      "hub: newcomer starts",
      "hub: newcomer presses",
      "hub: newcomer applies",
      "hub: declined starts",
      "hub: declined presses",
      "hub: declined applies",
      "hub: blocked starts",
      "hub: blocked presses",
      "hub: blocked applies",
      "hub: unknown outcome",
      "hub: closed queue applies",
      "hub: auction right only applies to a closed queue",
      "auction: auction right starts",
      "auction: auction right presses",
      "auction: hub right starts",
      "auction: hub right presses",
      "auction: hub right applies",
      "auction: admin starts",
      "auction: admin presses",
      "auction: auction right presses the statistics",
      "auction: admin host presses the statistics",
      "auction: hub right only starts",
      "auction: allowlisted applies",
      "auction: newcomer starts",
      "auction: newcomer presses",
      "auction: newcomer applies",
      "auction: declined starts",
      "auction: declined applies",
      "auction: blocked starts",
      "auction: blocked presses",
      "auction: blocked applies",
      "auction: unknown outcome",
      "auction: invitation-only outcome",
    ]);
  });
});
