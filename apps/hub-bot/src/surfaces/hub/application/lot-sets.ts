import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  AuctionFailure,
  DeleteLotSetResult,
  SaveLotSetResult,
} from "../auction/port.js";
import { acceptsLots, lotSetPrint } from "./auction-console.js";
import type {
  AuctionConsoleSnapshot,
  ExecuteResult,
  LotSet,
  LotSetNote,
  LotSetRef,
  LotSetsRequest,
} from "./types.js";

// Сеты лотов аукциона (ADR-073, PER-509): организатор называет сет и
// собирает его из лотов реестра, пока онлайн-торги не открыты; после открытия
// сеты видны только для просмотра. Своего состояния нет: каждая команда
// читает пульт заново — сеты в нём из агрегата аукциона, того же, по которому
// Auction проверяет команду, — и отдаёт Auction состав целиком. Право решает
// Auction: команды сета он пускает держателю `run_auctions`.

// Сколько сетов держит экран: ряд на сет, «Новый сет» и выход укладываются в
// двенадцать рядов. Ожидаем один-два сета на аукцион (ADR-073).
export const lotSetLimit = 10;

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
const meetupCancelled: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "meetup-cancelled",
};

/** Ссылка кнопки на сет: номер в порядке пульта и отпечаток идентификатора. */
export function lotSetRef(set: LotSet, index: number): LotSetRef {
  return { index, print: lotSetPrint(set.lotSetId) };
}

/** Сет по кнопке: номер и отпечаток совпали с прочитанным пультом. */
function lotSetAt(
  console: AuctionConsoleSnapshot,
  ref: LotSetRef,
): LotSet | undefined {
  const set = console.lotSets[ref.index];
  return set !== undefined && lotSetPrint(set.lotSetId) === ref.print
    ? set
    : undefined;
}

// Сеты в порядке идентификатора — в том же, в каком их отдаёт Auction.
// Сравнение строк, а не `localeCompare`: номер сета едет в кнопке и переживает
// перезапуск процесса.
function withSet(
  console: AuctionConsoleSnapshot,
  set: LotSet,
): AuctionConsoleSnapshot {
  const lotSets = [
    ...console.lotSets.filter((each) => each.lotSetId !== set.lotSetId),
    set,
  ].sort((a, b) =>
    a.lotSetId < b.lotSetId ? -1 : a.lotSetId > b.lotSetId ? 1 : 0,
  );
  return { ...console, lotSets };
}

export function createLotSets(consoles: AuctionConsoles) {
  type Read =
    | { kind: "ok"; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  async function read(request: LotSetsRequest): Promise<Read> {
    const found = await consoles.getAuctionConsole(
      request.identity,
      request.auctionId,
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        return found;
      case "not-administrator":
      case "meetup-not-found":
        return { kind: "refused", result: notAdministrator };
      case "auction-not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
  }

  // Исход команды над сетами — экран исхода с возвратом к «Сетам».
  function noted(
    console: AuctionConsoleSnapshot,
    note: LotSetNote,
  ): ExecuteResult {
    return { kind: "lot-sets", console, note };
  }

  // Отказы, общие у сохранения и удаления сета. Отказы состава каждая команда
  // разбирает до этой функции.
  function refused(
    console: AuctionConsoleSnapshot,
    result: Exclude<SaveLotSetResult | DeleteLotSetResult, { kind: "ok" }>,
  ): ExecuteResult {
    switch (result.kind) {
      case "lots-frozen":
        return noted(console, { kind: "frozen" });
      case "lot-not-in-auction":
        return noted(console, { kind: "lot-not-in-auction" });
      case "lot-in-another-set": {
        const holder = console.lotSets.find(
          (each) => each.lotSetId === result.lotSetId,
        );
        return noted(
          console,
          holder === undefined
            ? { kind: "lot-in-another-set" }
            : { kind: "lot-in-another-set", name: holder.name },
        );
      }
      case "lot-set-not-found":
        return noted(console, { kind: "already-deleted" });
      // Название проверено до команды: отказ теперь — дефект соседа.
      case "name-empty":
        return failed({
          kind: "invalid",
          cause: new Error("non-blank lot set name refused"),
        });
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      case "meetup-cancelled":
        return meetupCancelled;
      default:
        return failed(result);
    }
  }

  function save(
    request: LotSetsRequest & { opId: string },
    set: LotSet,
  ): Promise<SaveLotSetResult> {
    return consoles.saveLotSet(
      request.identity,
      {
        auctionId: request.auctionId,
        lotSetId: set.lotSetId,
        name: set.name,
        lotIds: set.lotIds,
        opId: request.opId,
      },
      rpcMeta(request),
    );
  }

  // Вопрос о названии — только пока сеты меняются и есть место для нового.
  async function ask(
    request: Extract<LotSetsRequest, { intent: "ask-lot-set" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!acceptsLots(console.status)) return noted(console, { kind: "frozen" });
    if (console.lotSets.length >= lotSetLimit) {
      return noted(console, { kind: "limit" });
    }
    return { kind: "lot-set-ask", auctionId: request.auctionId };
  }

  // Новый сет рождается пустым: Auction принимает неполный сет (ADR-073,
  // п. 1), а лоты организатор выбирает на экране сета, куда ответ и ведёт.
  async function add(
    request: Extract<LotSetsRequest, { intent: "add-lot-set" }>,
  ): Promise<ExecuteResult> {
    const name = request.value.trim();
    if (name === "") {
      return {
        kind: "lot-set-ask",
        auctionId: request.auctionId,
        error: "name-empty",
      };
    }
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!acceptsLots(console.status)) return noted(console, { kind: "frozen" });
    // Повтор того же ответа (PER-699): идентификатор сета выведен из сообщения,
    // и сет с ним уже заведён — открывается он сам, без команды. Пустой состав
    // второй раз не уходит в Auction и не стирает лоты, которые в сет уже
    // добавили, а предел сетов повтор не задевает.
    const existing = console.lotSets.findIndex(
      (each) => each.lotSetId === request.lotSetId,
    );
    if (existing !== -1) {
      return { kind: "lot-set", console, index: existing, at: { page: 0 } };
    }
    if (console.lotSets.length >= lotSetLimit) {
      return noted(console, { kind: "limit" });
    }
    const set: LotSet = { lotSetId: request.lotSetId, name, lotIds: [] };
    const saved = await save(request, set);
    if (saved.kind !== "ok") return refused(console, saved);
    const next = withSet(console, set);
    return {
      kind: "lot-set",
      console: next,
      index: next.lotSets.findIndex((each) => each.lotSetId === set.lotSetId),
      at: { page: 0 },
    };
  }

  async function view(
    request: Extract<LotSetsRequest, { intent: "view-lot-set" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (lotSetAt(console, request.set) === undefined) {
      return noted(console, { kind: "changed" });
    }
    return {
      kind: "lot-set",
      console,
      index: request.set.index,
      at: { page: request.page },
    };
  }

  // Лот в сете и вне его. Кнопка несёт целевое состояние: лот уже такой —
  // команды нет, а ответ тот же. Состав берётся из только что прочитанного
  // пульта, поэтому второе нажатие подряд видит лот первого.
  async function setLot(
    request: Extract<LotSetsRequest, { intent: "set-lot-set-lot" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    const set = lotSetAt(console, request.set);
    if (set === undefined) return noted(console, { kind: "changed" });
    if (!acceptsLots(console.status)) return noted(console, { kind: "frozen" });
    if (!console.lots.some((each) => each.lot.lotId === request.lotId)) {
      return noted(console, { kind: "lot-not-in-auction" });
    }
    const shown = (each: AuctionConsoleSnapshot): ExecuteResult => ({
      kind: "lot-set",
      console: each,
      index: request.set.index,
      at: { lotId: request.lotId },
      toggled: { selected: request.selected },
    });
    if (set.lotIds.includes(request.lotId) === request.selected) {
      return shown(console);
    }
    // Лот входит не больше чем в один сет (ADR-073, п. 1): Auction ответил бы
    // тем же отказом, но название чужого сета пульт знает и сам.
    const holder = console.lotSets.find(
      (each) =>
        each.lotSetId !== set.lotSetId && each.lotIds.includes(request.lotId),
    );
    if (request.selected && holder !== undefined) {
      return noted(console, { kind: "lot-in-another-set", name: holder.name });
    }
    const next: LotSet = {
      ...set,
      lotIds: request.selected
        ? [...set.lotIds, request.lotId]
        : set.lotIds.filter((lotId) => lotId !== request.lotId),
    };
    const saved = await save(request, next);
    return saved.kind === "ok"
      ? shown(withSet(console, next))
      : refused(console, saved);
  }

  async function prepareDelete(
    request: Extract<LotSetsRequest, { intent: "prepare-lot-set-delete" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (lotSetAt(console, request.set) === undefined) {
      return noted(console, { kind: "changed" });
    }
    if (!acceptsLots(console.status)) return noted(console, { kind: "frozen" });
    return {
      kind: "lot-set-delete-confirm",
      console,
      index: request.set.index,
    };
  }

  async function remove(
    request: Extract<LotSetsRequest, { intent: "delete-lot-set" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    const set = lotSetAt(console, request.set);
    if (set === undefined) return noted(console, { kind: "changed" });
    // «Да» могло висеть в чате с тех пор, как неделю открыли.
    if (!acceptsLots(console.status)) return noted(console, { kind: "frozen" });
    const deleted = await consoles.deleteLotSet(
      request.identity,
      {
        auctionId: request.auctionId,
        lotSetId: set.lotSetId,
        opId: request.opId,
      },
      rpcMeta(request),
    );
    if (deleted.kind !== "ok") return refused(console, deleted);
    return noted(
      {
        ...console,
        lotSets: console.lotSets.filter(
          (each) => each.lotSetId !== set.lotSetId,
        ),
      },
      { kind: "deleted", name: set.name },
    );
  }

  return async (request: LotSetsRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-lot-sets": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : { kind: "lot-sets", console: current.console };
      }
      case "ask-lot-set":
        return ask(request);
      case "add-lot-set":
        return add(request);
      case "view-lot-set":
        return view(request);
      case "set-lot-set-lot":
        return setLot(request);
      case "prepare-lot-set-delete":
        return prepareDelete(request);
      case "delete-lot-set":
        return remove(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
