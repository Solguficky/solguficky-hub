import type { LotView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type {
  ExecuteResult,
  FloorBidsRequest,
  FloorBidTarget,
  FloorLot,
  FloorNote,
  FloorPerson,
  FloorView,
} from "./types.js";

// «Ставки зала» помощника ведущего (PER-565, ADR-070 пп. 4–6): текущий лот
// финала, его цена и лидер и люди зала — все, кто выбрал имя в аукционе, —
// кнопками с объявленной ценой. Своего состояния нет: каждое нажатие читает
// аукцион заново, а лот, человек и цена едут в кнопке. Право решает Auction:
// чтение пульта и ставку зала он пускает держателю `run_auctions`.

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};

// Имя — по алфавиту без учёта регистра, равные — по идентификатору: место
// человека на экране не зависит ни от ставок, ни от порядка ответа Auction.
const collator = new Intl.Collator("ru", { sensitivity: "base" });
function byName(a: FloorPerson, b: FloorPerson): number {
  return (
    collator.compare(a.name, b.name) ||
    (a.participantId < b.participantId ? -1 : 1)
  );
}

function floorLotOf(lot: LotView, names: ReadonlyMap<string, string>) {
  const status = lot.status;
  // Чтение отстаёт от открытия лота: активный лот ещё удержан, и цена — та,
  // на которой его удержали. Следующей цены тогда нет, и ставить не на что.
  if (status.kind !== "trading" && status.kind !== "held") return undefined;
  const leaderName =
    status.leaderId === undefined ? undefined : names.get(status.leaderId);
  const floor: FloorLot = {
    lotId: lot.lotId,
    version: lot.version,
    currentPrice: status.currentPrice,
    ...(lot.card?.title === undefined ? {} : { title: lot.card.title }),
    ...(status.kind === "trading" &&
    status.phase === "live" &&
    lot.nextPrice !== undefined
      ? { nextPrice: lot.nextPrice }
      : {}),
    ...(status.leaderId === undefined ? {} : { leaderId: status.leaderId }),
    ...(leaderName === undefined ? {} : { leaderName }),
  };
  return floor;
}

function sameAmount(
  a: { minorUnits: number; currency: string } | undefined,
  b: { minorUnits: number; currency: string },
): boolean {
  return (
    a !== undefined &&
    a.minorUnits === b.minorUnits &&
    a.currency === b.currency
  );
}

export function createFloorBids(consoles: AuctionConsoles) {
  type Read =
    | { kind: "ok"; floor: FloorView }
    | { kind: "refused"; result: ExecuteResult };

  // Экран целиком: пульт даёт статус, состав и активный лот, имена аукциона —
  // людей зала. Имя лидера, которого в списке нет — у него сняли
  // `place_bids`, — дочитывается отдельно, и его отказ экран не роняет.
  async function read(
    request: FloorBidsRequest & { auctionId: string },
  ): Promise<Read> {
    const [found, listed] = await Promise.all([
      consoles.getAuctionConsole(
        request.identity,
        request.auctionId,
        rpcMeta(request),
      ),
      consoles.listAuctionNames(
        request.identity,
        request.auctionId,
        rpcMeta(request),
      ),
    ]);
    if (found.kind !== "ok") {
      switch (found.kind) {
        case "not-administrator":
        case "meetup-not-found":
          return { kind: "refused", result: notAdministrator };
        case "auction-not-found":
          return { kind: "refused", result: auctionNotFound };
        default:
          return { kind: "refused", result: failed(found) };
      }
    }
    if (listed.kind !== "ok") {
      return { kind: "refused", result: failed(listed) };
    }
    const people = listed.names
      .filter((each) => each.name !== "")
      .map((each) => ({ participantId: each.participantId, name: each.name }))
      .sort(byName);
    const names = new Map(
      people.map((each) => [each.participantId, each.name]),
    );
    const console = found.console;
    const active =
      console.status === "final" ? console.lineup?.activeLotId : undefined;
    const entry = console.lots.find((each) => each.lot.lotId === active);
    let lot = entry === undefined ? undefined : floorLotOf(entry.lot, names);
    if (lot?.leaderId !== undefined && lot.leaderName === undefined) {
      const leader = await consoles.displayNames(
        request.identity,
        { auctionId: request.auctionId, participantIds: [lot.leaderId] },
        rpcMeta(request),
      );
      const leaderName =
        leader.kind === "ok" ? leader.names[lot.leaderId] : undefined;
      if (leaderName !== undefined) lot = { ...lot, leaderName };
    }
    return {
      kind: "ok",
      floor: {
        auctionId: console.auctionId,
        status: console.status,
        ...(lot === undefined ? {} : { lot }),
        people,
        versions: Object.fromEntries(
          console.lots.map((each) => [each.lot.lotId, each.lot.version]),
        ),
      },
    };
  }

  async function view(
    request: Extract<FloorBidsRequest, { intent: "view-floor-bids" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const search = request.search?.trim();
    if (search === undefined || search === "") {
      return { kind: "floor-bids", floor: current.floor, page: request.page };
    }
    const needle = search.toLocaleLowerCase("ru");
    const people = current.floor.people.filter((each) =>
      each.name.toLocaleLowerCase("ru").includes(needle),
    );
    return people.length === 0
      ? {
          kind: "floor-bids",
          floor: current.floor,
          page: 0,
          note: { kind: "not-found", search },
        }
      : {
          kind: "floor-bids",
          floor: { ...current.floor, people },
          page: request.page,
          search,
        };
  }

  // Аукцион кнопки человека — у лота: в 64 байта рядом с лотом, человеком и
  // ценой он не помещается. Лот, которого Auction не отдаёт, — подделка или
  // лот другого аукциона, и экрана у него нет.
  async function lotRead(
    request: FloorBidsRequest & { target: FloorBidTarget },
    atLeastVersion?: number,
  ): Promise<
    { kind: "ok"; lot: LotView } | { kind: "refused"; result: ExecuteResult }
  > {
    const found = await consoles.floorLot(
      request.identity,
      {
        lotId: request.target.lotId,
        ...(atLeastVersion === undefined ? {} : { atLeastVersion }),
      },
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        return found;
      case "not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
  }

  // Сверка кнопки с экраном сейчас: лот тот же и торгуется, цена та же, и
  // человек — среди людей зала. Расхождение — экран с новым лотом или ценой,
  // а не ставка.
  type Checked =
    | { kind: "ok"; floor: FloorView; lot: FloorLot; person: FloorPerson }
    | { kind: "refused"; result: ExecuteResult };

  async function checked(
    request: FloorBidsRequest & { target: FloorBidTarget },
  ): Promise<Checked> {
    const found = await lotRead(request);
    if (found.kind === "refused") return found;
    const current = await read({ ...request, auctionId: found.lot.auctionId });
    if (current.kind === "refused") return current;
    const { floor } = current;
    const screen = (note: FloorNote): Checked => ({
      kind: "refused",
      result: { kind: "floor-bids", floor, page: 0, note },
    });
    const lot = floor.lot;
    if (lot === undefined || lot.lotId !== request.target.lotId) {
      return screen({ kind: "lot-changed" });
    }
    if (!sameAmount(lot.nextPrice, request.target.amount)) {
      return screen({ kind: "price-changed" });
    }
    const person = floor.people.find(
      (each) => each.participantId === request.target.participantId,
    );
    if (person === undefined) return screen({ kind: "cannot-bid" });
    if (lot.leaderId === person.participantId) {
      return screen({ kind: "bidder-is-leader", name: person.name });
    }
    return { kind: "ok", floor, lot, person };
  }

  async function prepare(
    request: Extract<FloorBidsRequest, { intent: "prepare-floor-bid" }>,
  ): Promise<ExecuteResult> {
    const found = await checked(request);
    if (found.kind === "refused") return found.result;
    return {
      kind: "floor-confirm",
      auctionId: found.floor.auctionId,
      lot: found.lot,
      person: found.person,
      amount: request.target.amount,
    };
  }

  // «Да» подтверждения. Повтора автоматом нет ни на каком исходе (ADR-070
  // п. 5): ставка, ответ на которую потерялся, могла пройти. Исход — строка
  // над экраном, прочитанным после ответа: имя лидера ответ не несёт.
  async function place(
    request: Extract<FloorBidsRequest, { intent: "place-floor-bid" }>,
  ): Promise<ExecuteResult> {
    const found = await checked(request);
    if (found.kind === "refused") return found.result;
    const { person } = found;
    const { amount } = request.target;
    const placed = await consoles.placeFloorBid(
      request.identity,
      {
        lotId: request.target.lotId,
        participantId: person.participantId,
        amount,
        opId: request.opId,
      },
      rpcMeta(request),
    );
    const after = async (
      note: FloorNote,
      lotVersion?: number,
    ): Promise<ExecuteResult> => {
      // Лот — не старее версии из ответа: пульт читает ту же отстающую read
      // model, и без дочитывания экран показал бы прежнюю цену.
      const [fresh, current] = await Promise.all([
        lotVersion === undefined
          ? undefined
          : lotRead(request, lotVersion).catch(() => undefined),
        read({ ...request, auctionId: found.floor.auctionId }),
      ]);
      if (current.kind === "refused") return current.result;
      let floor = current.floor;
      const names = new Map(
        floor.people.map((each) => [each.participantId, each.name]),
      );
      if (
        fresh?.kind === "ok" &&
        floor.lot?.lotId === fresh.lot.lotId &&
        fresh.lot.version > floor.lot.version
      ) {
        const lot = floorLotOf(fresh.lot, names);
        if (lot !== undefined) floor = { ...floor, lot };
      }
      if (note.kind !== "accepted") {
        return { kind: "floor-bids", floor, page: 0, note };
      }
      // Принято: лидер — тот, за кого ставили, либо автоставка ответила той
      // же транзакцией и цена выше названной.
      const lot = floor.lot;
      const answered =
        lot !== undefined &&
        lot.lotId === request.target.lotId &&
        lot.leaderId !== undefined &&
        lot.leaderId !== person.participantId &&
        lot.currentPrice.minorUnits > amount.minorUnits;
      return {
        kind: "floor-bids",
        floor,
        page: 0,
        note: answered
          ? {
              kind: "proxy-answered",
              name: person.name,
              price: amount,
              answer: lot.currentPrice,
            }
          : note,
      };
    };
    switch (placed.kind) {
      case "accepted":
        return after(
          { kind: "accepted", name: person.name, price: amount },
          placed.lotVersion > 0 ? placed.lotVersion : undefined,
        );
      case "bid-not-at-next-price": {
        // Имя лидера — из экрана после ответа: отказ его не несёт.
        const result = await after({ kind: "price-taken", price: amount });
        if (result.kind !== "floor-bids") return result;
        const leader = result.floor.lot?.leaderName;
        return {
          ...result,
          note: {
            kind: "price-taken",
            price: amount,
            ...(leader === undefined ? {} : { leader }),
          },
        };
      }
      case "bidder-is-leader":
        return after({ kind: "bidder-is-leader", name: person.name });
      case "lot-not-open":
        return after({ kind: "lot-not-open" });
      case "display-name-not-chosen":
        return after({ kind: "name-not-chosen", name: person.name });
      case "participant-cannot-bid":
        return after({ kind: "cannot-bid", name: person.name });
      case "removed-from-lot":
        return after({ kind: "removed-from-lot", name: person.name });
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "timeout":
      case "unavailable":
        return after({ kind: "unanswered", name: person.name, price: amount });
      default:
        return failed(placed);
    }
  }

  return async (request: FloorBidsRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-floor-bids":
        return view(request);
      case "ask-floor-search":
        return { kind: "floor-search-ask", auctionId: request.auctionId };
      case "prepare-floor-bid":
        return prepare(request);
      case "place-floor-bid":
        return place(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
