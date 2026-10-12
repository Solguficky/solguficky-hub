import {
  type AuctionDenial,
  type AuctionSurface,
  admission,
  applicationQueue,
  decideEntry,
  handleAuctionUpdate,
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

// Отказ разрешения личности: без права — приветствие, о заявке оно не знает.
const ANSWERS: Record<AuctionDenial, AccessAnswer> = {
  "not-admitted": "welcome",
  "in-community": "in-community",
  declined: "declined",
  blocked: "blocked",
};

// Отказ заявки: её исход виден человеку — «на рассмотрении», отказ, блок.
const ENTRY_ANSWERS: Record<AuctionDenial, AccessAnswer> = {
  ...ANSWERS,
  "not-admitted": "pending",
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

// Одна фабрика матрицы доступа, поверхность — параметр: `/start`, нажатие и
// «Подать заявку» доведены до политики шлюза так, как их доводит процесс.
// `/start` разрешает личность и заявки не ставит (PER-592, дополнение
// ADR-060); заявку ставит только «Подать заявку».
export const accessMatrixApp =
  (kind: AuctionSurface["kind"]): AccessMatrixApp =>
  (ports) =>
  async ({ from, firstName, action }) => {
    if (action.kind === "start") {
      const identity = await ports.identity.resolveIdentity(from);
      const refused = admission(kind, {
        rights: identity.viewer.rights,
        blocked: identity.blocked,
      });
      return refused === undefined ? "admitted" : ANSWERS[refused];
    }
    if (action.kind === "apply") {
      const entry = decideEntry(
        kind,
        await ports.entry.requestAccess({
          user: from,
          queue: applicationQueue(kind),
          ...(action.sourceCode === undefined
            ? {}
            : { sourceCode: action.sourceCode }),
          firstName,
        }),
      );
      if (entry.kind === "entered") return "admitted";
      return entry.kind === "denied"
        ? ENTRY_ANSWERS[entry.reason]
        : "unavailable";
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
