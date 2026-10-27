import type { AuctionStepWindow } from "../../../../gen/auction/v1/auction_pb.js";
import type {
  AuctionConsole,
  AuctionSnapshot,
  ConsolePredictions,
  ConsoleLot as WireConsoleLot,
  ConsoleLotSet as WireConsoleLotSet,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import { finalLineupOf, lotLayoutOf } from "../../../core/auction/auction.js";
import { lotViewOf, moneyOf } from "../../../core/auction/snapshot.js";
import type {
  AuctionConsoleSnapshot,
  AuctionWeek,
  ConsoleAuctionStatus,
  ConsoleLotSnapshot,
  LotSet,
  PredictionTally,
  StepWindow,
} from "../application/types.js";

// Перевод `auction.v1.AuctionConsole` в пульт хаба (PER-320). Как и перевод
// лота, он держит то, чего схема не выражает: статус и лот выставлены всегда,
// число ставок помещается в безопасное целое. Нарушение — дефект соседа:
// перевод бросает, и человек видит «недоступно», а не пульт с выдумкой.
export function consoleOf(console: AuctionConsole): AuctionConsoleSnapshot {
  const auction = console.auction;
  if (auction === undefined) throw new Error("auction console without auction");
  const week = weekOf(auction);
  const lineup = finalLineupOf(auction.status);
  const layout = lotLayoutOf(auction.lotLayout);
  return {
    auctionId: auction.id,
    status: statusOf(auction.status),
    hidden: auction.hidden,
    // Ориентировочное время финала (PER-663): анонс трансляции, а не условие
    // торгов. Нет — анонса нет, и пульт говорит об этом строкой.
    ...(auction.finalAt === undefined || auction.finalAt === ""
      ? {}
      : { finalAt: auction.finalAt }),
    ...(week === undefined ? {} : { week }),
    ...(lineup === undefined ? {} : { lineup }),
    // Запущенные по ходу торгов окна (PER-615): конфигурация их не знает, а
    // пульт показывает их рядом с объявленными.
    launchedWindows: console.launchedStepWindows.map(windowOf),
    lots: console.lots.map(consoleLotOf),
    lotSets: console.lotSets.map(lotSetOf),
    // Порядок и разделы ленты (PER-719); нет — лента в порядке создания.
    ...(layout === undefined ? {} : { layout }),
    // Розыгрыш и прогнозы числами (PER-734): организаторы подбирают призы по
    // числу участников. Нет поля — строки нет.
    ...(console.raffleRegistrations === undefined
      ? {}
      : { raffleRegistrations: console.raffleRegistrations }),
    ...(console.predictions === undefined
      ? {}
      : { predictionTally: predictionTallyOf(console.predictions) }),
  };
}

// Ответов не меньше, чем участников: у каждого считанного хотя бы один ответ.
function predictionTallyOf(predictions: ConsolePredictions): PredictionTally {
  if (predictions.answers < predictions.participants) {
    throw new Error("prediction tally with fewer answers than participants");
  }
  return {
    participants: predictions.participants,
    answers: predictions.answers,
  };
}

// Сет лотов (ADR-073, PER-509). Название у сета непустое всегда: Auction
// пустого не принимает.
function lotSetOf(set: WireConsoleLotSet): LotSet {
  if (set.lotSetId === "") throw new Error("lot set without id");
  if (set.name.trim() === "") throw new Error("lot set without name");
  return { lotSetId: set.lotSetId, name: set.name, lotIds: [...set.lotIds] };
}

function weekOf(auction: AuctionSnapshot): AuctionWeek | undefined {
  const config = auction.config;
  if (config === undefined) return undefined;
  const phase = config.onlinePhase;
  return {
    // Пустая строка — поле не выставлено: у онлайн-фазы начало обязательно,
    // а без фазы мгновений нет вовсе.
    ...(phase === undefined || phase.opensAt === ""
      ? {}
      : { opensAt: phase.opensAt }),
    ...(phase?.closesAt === undefined ? {} : { closesAt: phase.closesAt }),
    // Неделя без розыгрыша — поле не выставлено (ADR-066, п. 5).
    ...(phase?.raffleClosesAt === undefined
      ? {}
      : { raffleClosesAt: phase.raffleClosesAt }),
    // Приз розыгрыша (PER-649): нет поля или пробельная строка — приза нет.
    ...(phase?.rafflePrize === undefined || phase.rafflePrize.trim() === ""
      ? {}
      : { rafflePrize: phase.rafflePrize }),
    final: config.finalBlocks > 0,
    windows: config.stepWindows.map(windowOf),
    // Срок оплаты счёта (PER-722): Auction хранит его в каждой конфигурации,
    // а без поля команда его не шлёт и Auction подставит срок платформы.
    ...(config.paymentTermSeconds === undefined
      ? {}
      : { paymentTermSeconds: paymentTermOf(config.paymentTermSeconds) }),
  };
}

function paymentTermOf(seconds: bigint): number {
  const value = Number(seconds);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("payment term out of range");
  }
  return value;
}

// Окно «Счастливых часов» (PER-504). Шаг у окна обязателен: Auction без него
// окно не принимает, и пропуск — дефект соседа.
function windowOf(window: AuctionStepWindow): StepWindow {
  if (window.step === undefined) throw new Error("step window without step");
  return {
    from: window.from,
    until: window.until,
    step: moneyOf(window.step),
    lotIds: [...window.lotIds],
  };
}

function statusOf(status: AuctionSnapshot["status"]): ConsoleAuctionStatus {
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
      return "break";
    case "lineupFrozen":
      return "lineup-frozen";
    case "inFinal":
      return "final";
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

function consoleLotOf(entry: WireConsoleLot): ConsoleLotSnapshot {
  if (entry.lot === undefined) throw new Error("console lot without lot");
  const bidCount = Number(entry.lot.bidCount);
  if (!Number.isSafeInteger(bidCount) || bidCount < 0) {
    throw new Error("console lot bid count out of range");
  }
  return {
    lot: lotViewOf(entry.lot),
    bidCount,
    markedForFinal: entry.markedForFinal,
    overdue: entry.overdue,
  };
}
