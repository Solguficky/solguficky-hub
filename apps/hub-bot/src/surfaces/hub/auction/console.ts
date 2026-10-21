import type { AuctionStepWindow } from "../../../../gen/auction/v1/auction_pb.js";
import type {
  AuctionConsole,
  AuctionSnapshot,
  ConsoleLot as WireConsoleLot,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import { finalLineupOf } from "../../../core/auction/auction.js";
import { lotViewOf, moneyOf } from "../../../core/auction/snapshot.js";
import type {
  AuctionConsoleSnapshot,
  AuctionWeek,
  ConsoleAuctionStatus,
  ConsoleLotSnapshot,
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
  return {
    auctionId: auction.id,
    status: statusOf(auction.status),
    ...(week === undefined ? {} : { week }),
    ...(lineup === undefined ? {} : { lineup }),
    // Запущенные по ходу торгов окна (PER-615): конфигурация их не знает, а
    // пульт показывает их рядом с объявленными.
    launchedWindows: console.launchedStepWindows.map(windowOf),
    lots: console.lots.map(consoleLotOf),
  };
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
  };
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
    // Отменённый аукцион (ADR-047, дополнение 2026-10-12) экраны ещё не
    // показывают — это PER-606. Отменяют аукцион кнопка пульта (PER-606) и
    // отмена сходки (PER-602), и ни одной ещё нет, поэтому отменённого
    // аукциона в ответах не бывает; перевод бросает, как на незнакомом статусе.
    case "cancelled":
      throw new Error("auction snapshot is cancelled, not shown yet");
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
