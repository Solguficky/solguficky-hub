import type { AuctionSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionStageView,
  AuctionSummaryView,
  FinalLineupView,
  LotLayoutView,
} from "../../auction-ui/index.js";

// Снимок аукциона для его корня (PER-605) в словаре пакета. Перевод общий у
// обеих поверхностей. Снимок без статуса, неканонический идентификатор и
// момент, который не разбирается, — дефект соседа: перевод бросает, и человек
// видит «недоступно», а не корень с выдуманной стадией.
export function auctionSummaryViewOf(
  snapshot: AuctionSnapshot,
): AuctionSummaryView {
  if (!CANONICAL_UUID.test(snapshot.id)) {
    throw new Error("auction id is not a canonical UUID");
  }
  const phase = snapshot.config?.onlinePhase;
  const opensAt = instantOf(phase?.opensAt, "online phase start");
  const closesAt = instantOf(phase?.closesAt, "online phase end");
  return {
    auctionId: snapshot.id,
    stage: stageOf(snapshot.status),
    ...(opensAt === undefined ? {} : { opensAt }),
    ...(closesAt === undefined ? {} : { closesAt }),
    final: (snapshot.config?.finalBlocks ?? 0) > 0,
    ...withLineup(snapshot.status),
    ...(snapshot.hidden ? { hidden: true as const } : {}),
    ...withLayout(snapshot.lotLayout),
    ...withProgramme(snapshot),
    ...withPromoVideo(snapshot.promoVideo),
  };
}

// Промо-видео (PER-774) — украшение корня, как раскладка — подсказка ленте:
// кривой номер поста сводку не роняет, и кнопки «🎬 Промо» тогда нет.
function withPromoVideo(video: AuctionSnapshot["promoVideo"]) {
  const postId = promoVideoOf(video);
  return postId === undefined ? {} : { promoVideo: postId };
}

/**
 * Номер поста промо-видео в чате медиа ботов (PER-774, PER-781) или
 * `undefined`, если видео нет. Номер не положительный или шире номера
 * сообщения Telegram — тоже `undefined`: такого поста бот не покажет.
 */
export function promoVideoOf(
  video: AuctionSnapshot["promoVideo"],
): number | undefined {
  if (video === undefined) return undefined;
  const { messageId } = video;
  return messageId > 0n && messageId <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(messageId)
    : undefined;
}

// Раскладка в сводке — подсказка ленте (PER-719), как состав финала: кривая
// раскладка сводку не роняет, и лента идёт в порядке создания.
function withLayout(layout: AuctionSnapshot["lotLayout"]) {
  let view: LotLayoutView | undefined;
  try {
    view = lotLayoutOf(layout);
  } catch {
    view = undefined;
  }
  return view === undefined ? {} : { layout: view };
}

/**
 * Порядок и разделы ленты из снимка (PER-719) или `undefined`, если
 * администратор лоты не упорядочивал. Неканонический идентификатор, номер
 * раздела ноль, повтор номера или лота и пустое название — дефект соседа:
 * перевод бросает, и пульт показывает «недоступно», а не выдуманный порядок.
 */
export function lotLayoutOf(
  layout: AuctionSnapshot["lotLayout"],
): LotLayoutView | undefined {
  if (layout === undefined) return undefined;
  if (layout.lotIds.length === 0 && layout.sections.length === 0) {
    return undefined;
  }
  const seenLots = new Set<string>();
  const seenSections = new Set<number>();
  const lotsOf = (ids: readonly string[]): string[] =>
    ids.map((id) => {
      if (!CANONICAL_UUID.test(id)) {
        throw new Error("lot layout names a lot id that is not canonical");
      }
      if (seenLots.has(id)) throw new Error("lot layout names a lot twice");
      seenLots.add(id);
      return id;
    });
  const sections = layout.sections.map((section) => {
    if (section.sectionId === 0 || seenSections.has(section.sectionId)) {
      throw new Error("lot layout section id is zero or repeated");
    }
    seenSections.add(section.sectionId);
    if (section.name.trim() === "") {
      throw new Error("lot layout section name is blank");
    }
    return {
      sectionId: section.sectionId,
      name: section.name,
      lotIds: lotsOf(section.lotIds),
    };
  });
  return { lotIds: lotsOf(layout.lotIds), sections };
}

// Программа недели (PER-724) и строка состояния (PER-767) — подсказка корню
// и спискам, как состав — ленте: кривой момент окна, розыгрыша или финала
// выпадает из программы, а не роняет сводку.
function withProgramme(snapshot: AuctionSnapshot) {
  const finalAt = lenientInstant(snapshot.finalAt);
  const raffleClosesAt = lenientInstant(
    snapshot.config?.onlinePhase?.raffleClosesAt,
  );
  // Периоды «Счастливых часов» (PER-804) — те же часы для участника, что окна:
  // лоты периода — лоты с условиями в нём. Период без условий торгов не
  // меняет, и программа его не называет.
  const periods = snapshot.happyHourPeriods
    .filter((period) => period.lotTerms.length > 0)
    .map((period) => ({
      from: period.from,
      until: period.until,
      lotIds: period.lotTerms.map((terms) => terms.lotId),
    }));
  const stepWindows = [
    ...(snapshot.config?.stepWindows ?? []),
    ...snapshot.launchedStepWindows,
    ...periods,
  ]
    .flatMap((window) => {
      const from = lenientInstant(window.from);
      const until = lenientInstant(window.until);
      return from === undefined || until === undefined
        ? []
        : [{ from, until, lotIds: [...window.lotIds] }];
    })
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from));
  return {
    ...(finalAt === undefined ? {} : { finalAt }),
    ...(stepWindows.length === 0 ? {} : { stepWindows }),
    ...(raffleClosesAt === undefined ? {} : { raffleClosesAt }),
  };
}

function lenientInstant(value: string | undefined): string | undefined {
  try {
    return instantOf(value, "programme moment");
  } catch {
    return undefined;
  }
}

// Состав в сводке — подсказка ленте (PER-639), а сводку читают ещё список
// аукционов и корень. Кривой состав их не роняет: сводка остаётся без него, и
// лента показывает себя как вне финала. Строгим перевод остаётся у пульта.
function withLineup(status: AuctionSnapshot["status"]) {
  let lineup: FinalLineupView | undefined;
  try {
    lineup = finalLineupOf(status);
  } catch {
    lineup = undefined;
  }
  return lineup === undefined ? {} : { lineup };
}

/**
 * Состав финала из статуса снимка: есть у замороженного состава и у идущего
 * финала, и он никогда не пуст. Пустая строка активного лота — поле выставлено
 * пустым, а «между лотами» контракт выражает отсутствием поля.
 */
export function finalLineupOf(
  status: AuctionSnapshot["status"],
): FinalLineupView | undefined {
  if (status.case !== "lineupFrozen" && status.case !== "inFinal") {
    return undefined;
  }
  if (status.value.order.length === 0) {
    throw new Error("final lineup is empty");
  }
  const order = [...status.value.order];
  if (status.case === "lineupFrozen") return { order };
  const active = status.value.activeLotId;
  if (active === "") throw new Error("final active lot is empty");
  return active === undefined ? { order } : { order, activeLotId: active };
}

// Момент онлайн-фазы — RFC 3339 в UTC, как обещает `auction.v1.OnlinePhase`:
// «2026-10-21T21:00:00Z» или с долями секунды. `Date.parse` берёт и
// «2026-10-21», и «Oct 21, 2026», а выдуманное время в тексте читалось бы как
// срок (PER-688).
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function instantOf(
  value: string | undefined,
  what: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`auction ${what} is not an instant`);
  }
  return value;
}

function stageOf(status: AuctionSnapshot["status"]): AuctionStageView {
  switch (status.case) {
    case "draft":
      return "draft";
    case "scheduled":
      return "scheduled";
    case "prebidding":
      return "prebidding";
    case "settling":
      return "settling";
    case "onBreak":
      return "on-break";
    case "lineupFrozen":
      return "lineup-frozen";
    case "inFinal":
      return "in-final";
    case "finished":
      return "finished";
    // Отменённый аукцион (ADR-047, дополнение 2026-10-12) — конечная стадия,
    // как завершённый, и статус отличает одно от другого (PER-606).
    case "cancelled":
      return "cancelled";
    case undefined:
      throw new Error("auction snapshot without status");
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
