import { type Client, Code, ConnectError } from "@connectrpc/connect";
import type { NotificationsService } from "../../../gen/notifications/v1/notifications_service_pb.js";
import type {
  FavoritesPort,
  FollowOutcome,
  Viewer,
} from "../../auction-ui/index.js";

// Избранные лоты у Notifications (ADR-063, PER-495) — общие у двух ботов:
// участник торгует в боте хаба, гость — в боте аукциона, и отметка у человека
// одна. Тип клиента берётся из схемы: Pick роняет typecheck на расхождении с
// contracts/proto.
export type FavoritesRpc = Pick<
  Client<typeof NotificationsService>,
  "followLot" | "unfollowLot" | "listFollowedLots"
>;

// Параметры вызова считаются в момент вызова: бюджет действия режет дедлайн
// каждого, а `request_id` уезжает заголовком.
export type FavoritesCallOptions = () => {
  timeoutMs: number;
  headers?: Record<string, string>;
};

// Отказ чтения списка дерево на карточке гасит, и карточка остаётся без
// кнопки избранного. Чтобы деградация не была молчаливой, порт сообщает о ней
// до того, как бросить, — как об отказе имён.
export function createFavoritesPort(
  rpc: FavoritesRpc,
  options: FavoritesCallOptions,
  onListRefused?: (cause: unknown) => void,
): FavoritesPort {
  return {
    async listFollowedLots(viewer: Viewer) {
      try {
        const response = await rpc.listFollowedLots(
          { identityId: viewer.identityId },
          options(),
        );
        return response.lotIds;
      } catch (cause) {
        onListRefused?.(cause);
        throw cause;
      }
    },
    followLot: (request) =>
      outcomeOf(() =>
        rpc.followLot(
          { identityId: request.viewer.identityId, lotId: request.lotId },
          options(),
        ),
      ),
    unfollowLot: (request) =>
      outcomeOf(() =>
        rpc.unfollowLot(
          { identityId: request.viewer.identityId, lotId: request.lotId },
          options(),
        ),
      ),
  };
}

// `FAILED_PRECONDITION` — реплика лота в Notifications ещё не знает его:
// состояние не готово, и повтор решает человек (integration.md, «Избранные
// лоты»). Прочие отказы — сбой соседа, их порт бросает.
async function outcomeOf(
  call: () => Promise<{ following: boolean }>,
): Promise<FollowOutcome> {
  try {
    return { kind: "done", following: (await call()).following };
  } catch (cause) {
    if (
      cause instanceof ConnectError &&
      cause.code === Code.FailedPrecondition
    ) {
      return { kind: "not-ready" };
    }
    throw cause;
  }
}
