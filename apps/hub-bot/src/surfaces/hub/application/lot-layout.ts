import type { LotLayoutView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  AuctionFailure,
  LotLayoutResult,
} from "../auction/port.js";
import type {
  AuctionConsoleSnapshot,
  ConsoleAuctionStatus,
  ExecuteResult,
  LayoutDirection,
  LotLayoutNote,
  LotLayoutRequest,
} from "./types.js";

// Порядок и разделы ленты (PER-719): администратор поднимает и опускает лоты,
// заводит, переименовывает и удаляет разделы и переносит лоты между ними, пока
// финал впереди. Своего состояния нет: каждая команда читает пульт заново —
// раскладка в нём из агрегата аукциона, того же, по которому Auction
// проверяет команду, — и отдаёт Auction раскладку целиком. Право решает
// Auction: команду он пускает держателю `run_auctions`.

// Сколько разделов держит экран: ряд на раздел, общий список, «Новый раздел»
// и возврат укладываются в двенадцать рядов, а у экрана лота — переносы.
export const lotSectionLimit = 8;

/** Место общего списка в кнопке: разделы нумеруются с единицы. */
export const generalPlace = 0;

/** Раскладку можно менять, пока финал впереди (решение владельца 26.10). */
export function layoutEditable(status: ConsoleAuctionStatus): boolean {
  return status !== "final" && status !== "finished" && status !== "cancelled";
}

/**
 * Раскладка, какой её видит лента: лоты реестра, которых администратор не
 * упорядочил, стоят в конце общего списка в порядке заведения — по
 * идентификатору UUIDv7. Команда отдаёт Auction именно её, поэтому первая
 * правка закрепляет порядок, который участник уже видел.
 */
export function arrangedLayout(console: AuctionConsoleSnapshot): LotLayoutView {
  const layout = console.layout ?? { lotIds: [], sections: [] };
  const placed = new Set([
    ...layout.lotIds,
    ...layout.sections.flatMap((section) => section.lotIds),
  ]);
  const rest = console.lots
    .map((entry) => entry.lot.lotId)
    .filter((lotId) => !placed.has(lotId))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    lotIds: [...layout.lotIds, ...rest],
    sections: layout.sections.map((section) => ({
      ...section,
      lotIds: [...section.lotIds],
    })),
  };
}

/** Лоты места: раздела по номеру или общего списка; нет раздела — `undefined`. */
export function lotsOfPlace(
  layout: LotLayoutView,
  place: number,
): readonly string[] | undefined {
  if (place === generalPlace) return layout.lotIds;
  return layout.sections.find((section) => section.sectionId === place)?.lotIds;
}

/** Место лота в раскладке: номер раздела или общий список и позиция. */
export function placeOfLot(
  layout: LotLayoutView,
  lotId: string,
): { place: number; index: number } | undefined {
  const general = layout.lotIds.indexOf(lotId);
  if (general !== -1) return { place: generalPlace, index: general };
  for (const section of layout.sections) {
    const index = section.lotIds.indexOf(lotId);
    if (index !== -1) return { place: section.sectionId, index };
  }
  return undefined;
}

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

function swapped<T>(
  items: readonly T[],
  index: number,
  direction: LayoutDirection,
): T[] | undefined {
  const target = direction === "up" ? index - 1 : index + 1;
  const here = items[index];
  const there = items[target];
  if (here === undefined || there === undefined) return undefined;
  const next = [...items];
  next[index] = there;
  next[target] = here;
  return next;
}

/** Раскладка с другим составом места: общего списка или раздела. */
function withPlace(
  layout: LotLayoutView,
  place: number,
  lotIds: readonly string[],
): LotLayoutView {
  return place === generalPlace
    ? { ...layout, lotIds }
    : {
        ...layout,
        sections: layout.sections.map((section) =>
          section.sectionId === place ? { ...section, lotIds } : section,
        ),
      };
}

export function createLotLayout(consoles: AuctionConsoles) {
  type Read =
    | { kind: "ok"; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  async function read(request: LotLayoutRequest): Promise<Read> {
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

  function noted(
    console: AuctionConsoleSnapshot,
    note: LotLayoutNote,
  ): ExecuteResult {
    return { kind: "lot-layout", console, note };
  }

  function refused(
    console: AuctionConsoleSnapshot,
    result: Exclude<LotLayoutResult, { kind: "ok" }>,
  ): ExecuteResult {
    switch (result.kind) {
      case "final-already-started":
      case "auction-already-finished":
      case "auction-already-cancelled":
        return noted(console, { kind: "closed" });
      case "lot-not-in-auction":
        return noted(console, { kind: "lot-not-in-auction" });
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

  // Принятая раскладка — уже показанная: пульт перечитывать не нужно, и
  // экран рисуется из того, что ушло в Auction.
  async function save(
    request: LotLayoutRequest & { opId: string },
    console: AuctionConsoleSnapshot,
    layout: LotLayoutView,
    shown: (next: AuctionConsoleSnapshot) => ExecuteResult,
  ): Promise<ExecuteResult> {
    const saved = await consoles.setLotLayout(
      request.identity,
      { auctionId: request.auctionId, layout, opId: request.opId },
      rpcMeta(request),
    );
    return saved.kind === "ok"
      ? shown({ ...console, layout })
      : refused(console, saved);
  }

  // Общее начало команды: пульт прочитан и раскладку ещё можно менять.
  async function editable(
    request: LotLayoutRequest,
  ): Promise<
    | { kind: "ok"; console: AuctionConsoleSnapshot; layout: LotLayoutView }
    | { kind: "refused"; result: ExecuteResult }
  > {
    const current = await read(request);
    if (current.kind === "refused") return current;
    const { console } = current;
    if (!layoutEditable(console.status)) {
      return { kind: "refused", result: noted(console, { kind: "closed" }) };
    }
    return { kind: "ok", console, layout: arrangedLayout(console) };
  }

  async function moveLot(
    request: Extract<LotLayoutRequest, { intent: "move-lot-layout-lot" }>,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    const at = placeOfLot(layout, request.lotId);
    if (at === undefined) return noted(console, { kind: "changed" });
    const shown = (next: AuctionConsoleSnapshot): ExecuteResult => ({
      kind: "lot-layout-lot",
      console: next,
      lotId: request.lotId,
      moved: true,
    });
    const lots = lotsOfPlace(layout, at.place) ?? [];
    const next = swapped(lots, at.index, request.direction);
    // Лот уже на краю: двигать некуда, экран остаётся прежним.
    if (next === undefined) {
      return { kind: "lot-layout-lot", console, lotId: request.lotId };
    }
    return save(request, console, withPlace(layout, at.place, next), shown);
  }

  async function placeLot(
    request: Extract<LotLayoutRequest, { intent: "place-lot-layout-lot" }>,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    const at = placeOfLot(layout, request.lotId);
    const target = lotsOfPlace(layout, request.place);
    if (at === undefined || target === undefined) {
      return noted(console, { kind: "changed" });
    }
    // Кнопка несёт место назначения: лот уже там — команды нет.
    if (at.place === request.place) {
      return { kind: "lot-layout-lot", console, lotId: request.lotId };
    }
    const from = (lotsOfPlace(layout, at.place) ?? []).filter(
      (lotId) => lotId !== request.lotId,
    );
    const moved = withPlace(withPlace(layout, at.place, from), request.place, [
      ...target,
      request.lotId,
    ]);
    return save(request, console, moved, (next) => ({
      kind: "lot-layout-lot",
      console: next,
      lotId: request.lotId,
      moved: true,
    }));
  }

  async function ask(
    request: Extract<LotLayoutRequest, { intent: "ask-lot-section" }>,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    if (request.sectionId === undefined) {
      if (layout.sections.length >= lotSectionLimit) {
        return noted(console, { kind: "limit" });
      }
      return { kind: "lot-section-ask", auctionId: request.auctionId };
    }
    if (lotsOfPlace(layout, request.sectionId) === undefined) {
      return noted(console, { kind: "changed" });
    }
    return {
      kind: "lot-section-ask",
      auctionId: request.auctionId,
      sectionId: request.sectionId,
    };
  }

  // Название нового раздела или новое название раздела. Раздел с таким
  // названием уже есть — открывается он, без команды: так повторная доставка
  // того же ответа (PER-699) не заводит второй раздел и не упирается в чужой
  // ключ, а два раздела с одним названием участник всё равно не различил бы.
  // Переименование в название другого раздела — отказ ответу, а не молчаливый
  // переход в чужой раздел.
  async function name(
    request: Extract<LotLayoutRequest, { intent: "name-lot-section" }>,
  ): Promise<ExecuteResult> {
    const value = request.value.trim();
    if (value === "") {
      return {
        kind: "lot-section-ask",
        auctionId: request.auctionId,
        ...(request.sectionId === undefined
          ? {}
          : { sectionId: request.sectionId }),
        error: "name-empty",
      };
    }
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    const list = (next: AuctionConsoleSnapshot, place: number) =>
      ({
        kind: "lot-layout-list",
        console: next,
        place,
        at: { page: 0 },
      }) as const;
    const same = layout.sections.find((section) => section.name === value);
    if (
      same !== undefined &&
      request.sectionId !== undefined &&
      same.sectionId !== request.sectionId
    ) {
      return {
        kind: "lot-section-ask",
        auctionId: request.auctionId,
        sectionId: request.sectionId,
        error: "name-taken",
      };
    }
    if (same !== undefined) return list(console, same.sectionId);
    if (request.sectionId !== undefined) {
      const { sectionId } = request;
      if (lotsOfPlace(layout, sectionId) === undefined) {
        return noted(console, { kind: "changed" });
      }
      const renamed: LotLayoutView = {
        ...layout,
        sections: layout.sections.map((section) =>
          section.sectionId === sectionId
            ? { ...section, name: value }
            : section,
        ),
      };
      return save(request, console, renamed, (next) => list(next, sectionId));
    }
    if (layout.sections.length >= lotSectionLimit) {
      return noted(console, { kind: "limit" });
    }
    const sectionId =
      Math.max(0, ...layout.sections.map((section) => section.sectionId)) + 1;
    const added: LotLayoutView = {
      ...layout,
      sections: [...layout.sections, { sectionId, name: value, lotIds: [] }],
    };
    return save(request, console, added, (next) => list(next, sectionId));
  }

  async function moveSection(
    request: Extract<LotLayoutRequest, { intent: "move-lot-section" }>,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    const index = layout.sections.findIndex(
      (section) => section.sectionId === request.sectionId,
    );
    if (index === -1) return noted(console, { kind: "changed" });
    const shown = (next: AuctionConsoleSnapshot): ExecuteResult => ({
      kind: "lot-layout-list",
      console: next,
      place: request.sectionId,
      at: { page: 0 },
    });
    const sections = swapped(layout.sections, index, request.direction);
    if (sections === undefined) return shown(console);
    return save(request, console, { ...layout, sections }, shown);
  }

  async function prepareDelete(
    request: Extract<
      LotLayoutRequest,
      { intent: "prepare-lot-section-delete" }
    >,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    if (lotsOfPlace(layout, request.sectionId) === undefined) {
      return noted(console, { kind: "changed" });
    }
    return {
      kind: "lot-section-delete-confirm",
      console,
      sectionId: request.sectionId,
    };
  }

  // Лоты удалённого раздела уходят в конец общего списка в его порядке: из
  // ленты они не пропадают.
  async function remove(
    request: Extract<LotLayoutRequest, { intent: "delete-lot-section" }>,
  ): Promise<ExecuteResult> {
    const current = await editable(request);
    if (current.kind === "refused") return current.result;
    const { console, layout } = current;
    const section = layout.sections.find(
      (each) => each.sectionId === request.sectionId,
    );
    if (section === undefined) return noted(console, { kind: "changed" });
    const removed: LotLayoutView = {
      lotIds: [...layout.lotIds, ...section.lotIds],
      sections: layout.sections.filter((each) => each !== section),
    };
    return save(request, console, removed, (next) =>
      noted(next, { kind: "deleted", name: section.name }),
    );
  }

  return async (request: LotLayoutRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-lot-layout": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : { kind: "lot-layout", console: current.console };
      }
      case "view-lot-layout-list": {
        const current = await read(request);
        if (current.kind === "refused") return current.result;
        const { console } = current;
        if (lotsOfPlace(arrangedLayout(console), request.place) === undefined) {
          return noted(console, { kind: "changed" });
        }
        return {
          kind: "lot-layout-list",
          console,
          place: request.place,
          at: { page: request.page },
        };
      }
      case "view-lot-layout-lot": {
        const current = await read(request);
        if (current.kind === "refused") return current.result;
        const { console } = current;
        return placeOfLot(arrangedLayout(console), request.lotId) === undefined
          ? noted(console, { kind: "changed" })
          : { kind: "lot-layout-lot", console, lotId: request.lotId };
      }
      case "move-lot-layout-lot":
        return moveLot(request);
      case "place-lot-layout-lot":
        return placeLot(request);
      case "ask-lot-section":
        return ask(request);
      case "name-lot-section":
        return name(request);
      case "move-lot-section":
        return moveSection(request);
      case "prepare-lot-section-delete":
        return prepareDelete(request);
      case "delete-lot-section":
        return remove(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
