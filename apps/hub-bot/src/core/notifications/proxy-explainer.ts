import type { Client } from "@connectrpc/connect";
import type { NotificationsService } from "../../../gen/notifications/v1/notifications_service_pb.js";
import type { ProxyExplainerPort, Viewer } from "../../auction-ui/index.js";
import type { FavoritesCallOptions } from "./favorites.js";

// Отметка «пояснение автоставки видено» у Notifications (PER-517) — общая у
// двух ботов: вопрос лимита есть у обоих, и отметка у человека одна. Тип
// клиента берётся из схемы: Pick роняет typecheck на расхождении с
// contracts/proto.
export type ProxyExplainerRpc = Pick<
  Client<typeof NotificationsService>,
  "getProxyExplainer" | "markProxyExplainerSeen"
>;

// Отказ дерево гасит: пояснение показывается ещё раз, а принятая автоставка
// остаётся принятой. Чтобы деградация не была молчаливой, порт сообщает о ней
// до того, как бросить, — как избранное.
export function createProxyExplainerPort(
  rpc: ProxyExplainerRpc,
  options: FavoritesCallOptions,
  onRefused?: (cause: unknown) => void,
): ProxyExplainerPort {
  const reported = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (cause) {
      onRefused?.(cause);
      throw cause;
    }
  };
  return {
    seen: (viewer: Viewer) =>
      reported(async () => {
        const response = await rpc.getProxyExplainer(
          { identityId: viewer.identityId },
          options(),
        );
        return response.seen;
      }),
    markSeen: (viewer: Viewer) =>
      reported(async () => {
        await rpc.markProxyExplainerSeen(
          { identityId: viewer.identityId },
          options(),
        );
      }),
  };
}
