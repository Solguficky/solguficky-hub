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
    const snapshot = found.console;
    const active =
      snapshot.status === "final" ? snapshot.lineup?.activeLotId : undefined;
    const entry = snapshot.lots.find((each) => each.lot.lotId === active);
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
        auctionId: snapshot.auctionId,
        status: snapshot.status,
        ...(lot === undefined ? {} : { lot }),
        people,
        versions: Object.fromEntries(
          snapshot.lots.map((each) => [each.lot.lotId, each.lot.version]),
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

  // Лот кнопки поверх экрана: снимок лота не старше пульта, а пульт читает ту
  // же отстающую read model, поэтому экран берёт более свежее из двух. Версия
  // лота уходит и в версии экрана: иначе поток счёл бы её новой и перечитал
  // экран, стерев строку исхода.
  function withLot(floor: FloorView, lot: LotView): FloorView {
    if (floor.lot?.lotId !== lot.lotId || lot.version <= floor.lot.version) {
      return floor;
    }
    const names = new Map(
      floor.people.map((each) => [each.participantId, each.name]),
    );
    const fresh = floorLotOf(lot, names);
    if (fresh === undefined) return floor;
    return {
      ...floor,
      lot: {
        ...fresh,
        ...(fresh.leaderName === undefined &&
        fresh.leaderId === floor.lot.leaderId &&
        floor.lot.leaderName !== undefined
          ? { leaderName: floor.lot.leaderName }
          : {}),
      },
      versions: { ...floor.versions, [lot.lotId]: lot.version },
    };
  }

  // Сверка кнопки с лотом сейчас: лот торгуется в живом финале, цена не ушла
  // выше названной, и человек — среди людей зала. Расхождение — экран с новым
  // лотом или ценой, а не ставка. Цена ниже названной — отставание чтения,
  // а не ставка на другую цену: её решает Auction (`BidNotAtNextPrice`).
  type Checked =
    | {
        kind: "ok";
        floor: FloorView;
        lot: FloorLot;
        person: FloorPerson;
      }
    | { kind: "refused"; result: ExecuteResult };

  async function checked(
    request: FloorBidsRequest & { target: FloorBidTarget },
  ): Promise<Checked> {
    const found = await lotRead(request);
    if (found.kind === "refused") return found;
    const current = await read({ ...request, auctionId: found.lot.auctionId });
    if (current.kind === "refused") return current;
    const floor = withLot(current.floor, found.lot);
    const screen = (note: FloorNote): Checked => ({
      kind: "refused",
      result: { kind: "floor-bids", floor, page: 0, note },
    });
    const status = found.lot.status;
    if (status.kind !== "trading" || status.phase !== "live") {
      return screen({ kind: "lot-changed" });
    }
    const next = found.lot.nextPrice;
    const { amount } = request.target;
    if (
      next === undefined ||
      next.currency !== amount.currency ||
      next.minorUnits > amount.minorUnits
    ) {
      return screen({ kind: "price-changed" });
    }
    const person = floor.people.find(
      (each) => each.participantId === request.target.participantId,
    );
    if (person === undefined) return screen({ kind: "cannot-bid" });
    if (
      status.leaderId === person.participantId &&
      next.minorUnits === amount.minorUnits
    ) {
      return screen({ kind: "bidder-is-leader", name: person.name });
    }
    const lot = floorLotOf(found.lot, new Map()) ?? floor.lot;
    if (lot === undefined) return screen({ kind: "lot-changed" });
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
    // Экран после ответа. Лот — не старее версии из ответа: пульт читает ту же
    // отстающую read model, и без дочитывания экран показал бы прежнюю цену.
    // Чтение отказало — исход ставки важнее свежего экрана: без него помощник
    // не узнал бы, прошла ли необратимая ставка. Экран тогда — прочитанный до
    // команды, с пометкой, что цена могла устареть.
    const after = async (
      lotVersion?: number,
    ): Promise<{ floor: FloorView; stale: boolean; fresh?: LotView }> => {
      const [fresh, current] = await Promise.all([
        lotVersion === undefined ? undefined : lotRead(request, lotVersion),
        read({ ...request, auctionId: found.floor.auctionId }),
      ]);
      const base = current.kind === "ok" ? current.floor : found.floor;
      return fresh?.kind === "ok"
        ? {
            floor: withLot(base, fresh.lot),
            stale: current.kind !== "ok",
            fresh: fresh.lot,
          }
        : { floor: base, stale: current.kind !== "ok" };
    };
    const shown = (
      screen: { floor: FloorView; stale: boolean },
      note: FloorNote,
    ): ExecuteResult => ({
      kind: "floor-bids",
      floor: screen.floor,
      page: 0,
      note,
      ...(screen.stale ? { stale: true as const } : {}),
    });
    switch (placed.kind) {
      case "accepted": {
        const lotVersion =
          placed.lotVersion > 0 ? placed.lotVersion : undefined;
        const screen = await after(lotVersion);
        const lot = screen.floor.lot;
        const outbid =
          lot !== undefined &&
          lot.lotId === request.target.lotId &&
          lot.leaderId !== undefined &&
          lot.leaderId !== person.participantId &&
          lot.currentPrice.minorUnits > amount.minorUnits;
        if (!outbid) {
          return shown(screen, {
            kind: "accepted",
            name: person.name,
            price: amount,
          });
        }
        // Лидер сменился той же командой — ответила автоставка: принятая
        // ставка видна лотом ровно с версией из ответа. Лот новее — цену
        // подняли уже после ставки, и кто, экран не знает.
        return shown(
          screen,
          screen.fresh !== undefined && screen.fresh.version === lotVersion
            ? {
                kind: "proxy-answered",
                name: person.name,
                price: amount,
                answer: lot.currentPrice,
              }
            : {
                kind: "outbid",
                name: person.name,
                price: amount,
                now: lot.currentPrice,
              },
        );
      }
      case "bid-not-at-next-price": {
        // Имя лидера — из экрана после ответа: отказ его не несёт. Следующую
        // цену отказ называет сам, и экран её показывает, даже если чтение
        // ещё не догнало чужую ставку, — как карточка финала.
        const screen = await after();
        const lot = screen.floor.lot;
        const floor =
          lot !== undefined &&
          lot.lotId === request.target.lotId &&
          (lot.nextPrice === undefined ||
            lot.nextPrice.minorUnits < placed.expected.minorUnits)
            ? { ...screen.floor, lot: { ...lot, nextPrice: placed.expected } }
            : screen.floor;
        const leader = floor.lot?.leaderName;
        return shown(
          { floor, stale: screen.stale },
          {
            kind: "price-taken",
            price: amount,
            ...(leader === undefined ? {} : { leader }),
          },
        );
      }
      case "bidder-is-leader":
        return shown(await after(), {
          kind: "bidder-is-leader",
          name: person.name,
        });
      case "lot-not-open":
        return shown(await after(), { kind: "lot-not-open" });
      case "display-name-not-chosen":
        return shown(await after(), {
          kind: "name-not-chosen",
          name: person.name,
        });
      case "participant-cannot-bid":
        return shown(await after(), { kind: "cannot-bid", name: person.name });
      case "removed-from-lot":
        return shown(await after(), {
          kind: "removed-from-lot",
          name: person.name,
        });
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "timeout":
      case "unavailable":
        return shown(await after(), {
          kind: "unanswered",
          name: person.name,
          price: amount,
        });
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
