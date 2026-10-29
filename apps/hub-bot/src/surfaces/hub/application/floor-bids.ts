import type { LotView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type { CommunityAdministrator } from "../identity/port.js";
import type { FloorRoomStore, RoomMember } from "./floor-room.js";
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
// финала, его цена и лидер и люди зала кнопками с объявленной ценой. Людей
// зала с 29.10.2026 набирает помощник сам (PER-816): ставка уходит нажатием на
// человека из состава, без подтверждения, а ошибку исправляет снятие
// участника с лота. Состав — в `FloorRoomStore`, имена — из списка имён
// аукциона. Право решает Auction: чтение пульта и ставку зала он пускает
// держателю `run_auctions`.

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

export function createFloorBids(
  consoles: AuctionConsoles,
  room: FloorRoomStore,
  directory?: Pick<CommunityAdministrator, "community">,
) {
  type Read =
    | { kind: "ok"; floor: FloorView }
    | { kind: "refused"; result: ExecuteResult };

  // Экран целиком: пульт даёт статус, состав и активный лот, имена аукциона —
  // людей зала. Имя лидера, которого в списке нет — у него сняли
  // `place_bids`, — дочитывается отдельно, и его отказ экран не роняет.
  async function read(
    request: FloorBidsRequest & { auctionId: string },
  ): Promise<Read> {
    const [found, listed, stored] = await Promise.all([
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
      room.read(request.auctionId),
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
    // Имена — у всех, кто выбрал их в аукционе; людьми зала становятся только
    // те, кого помощник внёс в состав.
    const named = listed.names
      .filter((each) => each.name !== "")
      .map((each) => ({ participantId: each.participantId, name: each.name }));
    const names = new Map(named.map((each) => [each.participantId, each.name]));
    const members = stored.kind === "ok" ? stored.members : [];
    const inRoom = new Set(members.map((each) => each.identityId));
    const people = named
      .filter((each) => inRoom.has(each.participantId))
      .sort(byName);
    const waiting = members.filter((each) => !names.has(each.identityId));
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
        waiting,
        ...(stored.kind === "ok" ? {} : { roomUnavailable: true as const }),
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
    const edit = request.edit === true ? { edit: true as const } : {};
    const search = request.search?.trim();
    if (search === undefined || search === "") {
      return {
        kind: "floor-bids",
        floor: current.floor,
        page: request.page,
        ...edit,
      };
    }
    // Поиск — по нику среди участников сообщества (PER-816): человека, которого
    // в зале ещё нет, помощник находит и добавляет в состав.
    const found = await members(request, search);
    if (found.kind !== "ok") {
      return {
        kind: "floor-bids",
        floor: current.floor,
        page: 0,
        note: { kind: "members-unavailable" },
      };
    }
    return found.members.length === 0
      ? {
          kind: "floor-bids",
          floor: current.floor,
          page: 0,
          note: { kind: "not-found", search },
        }
      : {
          kind: "floor-bids",
          floor: { ...current.floor, found: found.members },
          page: 0,
          search,
        };
  }

  // Люди сообщества с кругом `member`, чей ник содержит строку. Список
  // Identity отдаёт держателю права состава; без него поиска нет.
  async function members(
    request: { identity: { identityId: string } } & FloorBidsRequest,
    search?: string,
  ): Promise<
    { kind: "ok"; members: readonly RoomMember[] } | { kind: "unavailable" }
  > {
    if (directory === undefined) return { kind: "unavailable" };
    const listed = await directory.community(
      { identityId: request.identity.identityId },
      "members",
      rpcMeta(request),
    );
    if (listed.kind !== "ok") return { kind: "unavailable" };
    const needle = search?.toLocaleLowerCase("ru");
    return {
      kind: "ok",
      members: listed.value.members
        .filter(
          (each) =>
            each.circle === "member" &&
            each.telegramUsername !== undefined &&
            (needle === undefined ||
              each.telegramUsername.toLocaleLowerCase("ru").includes(needle)),
        )
        .slice(0, 16)
        .map((each) => ({
          identityId: each.identityId,
          ...(each.telegramUsername === undefined
            ? {}
            : { username: each.telegramUsername }),
        })),
    };
  }

  const label = (member: RoomMember, floor: FloorView) =>
    floor.people.find((each) => each.participantId === member.identityId)
      ?.name ??
    (member.username === undefined ? "Участник" : `@${member.username}`);

  // Добавить человека в состав: Identity подтверждает, что он участник
  // сообщества, а ник берётся оттуда же, не из кнопки.
  async function add(
    request: Extract<FloorBidsRequest, { intent: "add-floor-member" }>,
  ): Promise<ExecuteResult> {
    const all = await members(request);
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const screen = (note: FloorNote): ExecuteResult => ({
      kind: "floor-bids",
      floor: current.floor,
      page: 0,
      note,
    });
    if (all.kind !== "ok") return screen({ kind: "members-unavailable" });
    const member = all.members.find(
      (each) => each.identityId === request.memberId,
    );
    if (member === undefined) return screen({ kind: "cannot-bid" });
    const already =
      current.floor.people.some(
        (each) => each.participantId === member.identityId,
      ) ||
      current.floor.waiting.some(
        (each) => each.identityId === member.identityId,
      );
    if (already) return screen({ kind: "member-already-in" });
    const written = await room.add(request.auctionId, member);
    if (written.kind !== "ok") return screen({ kind: "room-write-failed" });
    const after = await read(request);
    const floor = after.kind === "ok" ? after.floor : current.floor;
    return {
      kind: "floor-bids",
      floor,
      page: 0,
      note: { kind: "member-added", name: label(member, floor) },
    };
  }

  async function removeMember(
    request: Extract<FloorBidsRequest, { intent: "remove-floor-member" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const member = [
      ...current.floor.people.map((each) => ({
        identityId: each.participantId,
      })),
      ...current.floor.waiting,
    ].find((each) => each.identityId === request.memberId);
    const written = await room.remove(request.auctionId, request.memberId);
    if (written.kind !== "ok") {
      return {
        kind: "floor-bids",
        floor: current.floor,
        page: 0,
        edit: true,
        note: { kind: "room-write-failed" },
      };
    }
    const after = await read(request);
    const floor = after.kind === "ok" ? after.floor : current.floor;
    return {
      kind: "floor-bids",
      floor,
      page: 0,
      edit: true,
      ...(member === undefined
        ? {}
        : {
            note: {
              kind: "member-removed" as const,
              name: label(member, current.floor),
            },
          }),
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
    if (person === undefined) {
      // Человек в составе без имени в аукционе: ставка за него невозможна,
      // пока он не выберет имя. Вне состава — устаревший экран.
      return floor.waiting.some(
        (each) => each.identityId === request.target.participantId,
      )
        ? screen({ kind: "name-not-chosen" })
        : screen({ kind: "not-in-room" });
    }
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
      case "add-floor-member":
        return add(request);
      case "remove-floor-member":
        return removeMember(request);
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
