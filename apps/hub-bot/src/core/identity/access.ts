import {
  ApplicationQueue as WireQueue,
  AccessRight as WireRight,
} from "../../../gen/identity/v1/roles_pb.js";
import type {
  AccessRight,
  ApplicationQueue,
  Viewer,
} from "../../auction-ui/index.js";

// Перевод прав и очереди `identity.v1` в словарь аукционного дерева — один у
// обеих поверхностей: по этим правам шлюз решает допуск (ADR-064, пункт 6).

// Незнакомое и пустое значение отбрасывается: по контракту оно ничего не даёт.
export function rightsOf(rights: readonly WireRight[]): AccessRight[] {
  return rights.flatMap((right) => {
    const name = rightName(right);
    return name === undefined ? [] : [name];
  });
}

function rightName(right: WireRight): AccessRight | undefined {
  switch (right) {
    case WireRight.HUB:
      return "hub";
    case WireRight.AUCTION:
      return "auction";
    case WireRight.MANAGE_MEMBERSHIP:
      return "manage-membership";
    case WireRight.MODERATE_AUCTION:
      return "moderate-auction";
    case WireRight.MANAGE_AUCTION:
      return "manage-auction";
    case WireRight.UNSPECIFIED:
      return undefined;
    default:
      // Новое значение словаря обязано получить имя: параметр типа never не
      // соберётся. Число, которого словарь ещё не знает, игнорируется.
      return ignoreUnknownRight(right);
  }
}

function ignoreUnknownRight(_right: never): undefined {
  return undefined;
}

// Смотрящий в `auction.v1.Viewer`: права уходят в Auction, как их вывел
// Identity, и решает по ним он сам. Поле ролей остаётся пустым — Auction его не
// читает, а снимается оно из контракта отдельно.
export function wireViewer(viewer: Viewer): {
  identityId: string;
  rights: WireRight[];
} {
  return {
    identityId: viewer.identityId,
    rights: viewer.rights.map(rightValue),
  };
}

function rightValue(right: AccessRight): WireRight {
  switch (right) {
    case "hub":
      return WireRight.HUB;
    case "auction":
      return WireRight.AUCTION;
    case "manage-membership":
      return WireRight.MANAGE_MEMBERSHIP;
    case "moderate-auction":
      return WireRight.MODERATE_AUCTION;
    case "manage-auction":
      return WireRight.MANAGE_AUCTION;
    default: {
      const _exhaustive: never = right;
      return _exhaustive;
    }
  }
}

export function wireQueue(queue: ApplicationQueue): WireQueue {
  switch (queue) {
    case "community":
      return WireQueue.COMMUNITY;
    case "auction":
      return WireQueue.AUCTION;
    default: {
      const _exhaustive: never = queue;
      return _exhaustive;
    }
  }
}
