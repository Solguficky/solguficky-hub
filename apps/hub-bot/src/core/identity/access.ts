import {
  ApplicationQueue as WireQueue,
  AccessRight as WireRight,
} from "../../../gen/identity/v1/access_pb.js";
import type {
  AccessRight,
  ApplicationQueue,
  Viewer,
} from "../../auction-ui/index.js";

// Перевод прав и очереди `identity.v1` в словарь аукционного дерева — один у
// обеих поверхностей: по этим правам шлюз решает допуск (RFC-016).

// Незнакомое и пустое значение отбрасывается: по контракту оно ничего не даёт.
export function rightsOf(rights: readonly WireRight[]): AccessRight[] {
  return rights.flatMap((right) => {
    const name = rightName(right);
    return name === undefined ? [] : [name];
  });
}

function rightName(right: WireRight): AccessRight | undefined {
  switch (right) {
    case WireRight.ACCESS_HUB:
      return "access-hub";
    case WireRight.PLACE_BIDS:
      return "place-bids";
    case WireRight.MANAGE_MEMBERS:
      return "manage-members";
    case WireRight.ADMIT_BIDDERS:
      return "admit-bidders";
    case WireRight.MANAGE_MEETUPS:
      return "manage-meetups";
    case WireRight.GRANT_ADMINS:
      return "grant-admins";
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

// Смотрящий в `auction.v1.Viewer` и `meetups.v1.Viewer`: права уходят в
// сервис, как их вывел Identity, и решает по ним он сам.
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
    case "access-hub":
      return WireRight.ACCESS_HUB;
    case "place-bids":
      return WireRight.PLACE_BIDS;
    case "manage-members":
      return WireRight.MANAGE_MEMBERS;
    case "admit-bidders":
      return WireRight.ADMIT_BIDDERS;
    case "manage-meetups":
      return WireRight.MANAGE_MEETUPS;
    case "grant-admins":
      return WireRight.GRANT_ADMINS;
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
