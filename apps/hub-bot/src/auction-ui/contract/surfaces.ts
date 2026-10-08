import {
  type AuctionDenial,
  type AuctionSurface,
  decideEntry,
  handleAuctionUpdate,
  requestedRole,
} from "../gateway.js";
import type { AccessAnswer, AccessMatrixApp } from "./access.js";
import type { AuctionContractApp } from "./check.js";

// Все поверхности аукционного дерева. `Record` по виду поверхности делает
// перечень полным: новая поверхность без записи здесь не соберётся, и contract
// suite с матрицей не смогут её пропустить (ADR-064, п. 19).
const KNOWN: Record<AuctionSurface["kind"], true> = {
  hub: true,
  auction: true,
};
export const AUCTION_SURFACES = Object.keys(KNOWN) as AuctionSurface["kind"][];

const ANSWERS: Record<AuctionDenial, AccessAnswer> = {
  "not-admitted": "pending",
  declined: "declined",
  blocked: "blocked",
};

// Одна фабрика contract suite, поверхность — параметр: нажатие доведено ровно
// до шлюза, как его доводит процесс, — личность разрешается один раз и уходит
// в update.
export const auctionContractApp =
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

// Одна фабрика матрицы доступа, поверхность — параметр: вход на `/start` и
// нажатие доведены до политики шлюза так, как их доводит процесс.
export const accessMatrixApp =
  (kind: AuctionSurface["kind"]): AccessMatrixApp =>
  (ports) =>
  async ({ from, firstName, action }) => {
    if (action.kind === "start") {
      const entry = decideEntry(
        kind,
        await ports.entry.requestRole({
          user: from,
          requestedRole: requestedRole(kind),
          ...(action.sourceCode === undefined
            ? {}
            : { sourceCode: action.sourceCode }),
          firstName,
        }),
      );
      if (entry.kind === "entered") return "admitted";
      return entry.kind === "denied" ? ANSWERS[entry.reason] : "unavailable";
    }
    const result = await handleAuctionUpdate(
      { kind, ports },
      {
        identity: await ports.identity.resolveIdentity(from),
        user: from,
        input: action,
      },
    );
    if (result.kind === "screen") return "admitted";
    if (result.kind === "denied") return ANSWERS[result.reason];
    throw result.error;
  };
