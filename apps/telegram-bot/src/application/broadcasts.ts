import type { Notifications } from "../notifications/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type { BroadcastRequest, ExecuteResult } from "./types.js";

// Предел сообщения Telegram в UTF-16-единицах — тот же, которым Notifications
// ограничивает тело рассылки (docs/architecture/integration.md). Длина строки
// JavaScript считается в тех же единицах, поэтому пересчёта не нужно.
export const broadcastBodyLimit = 4096;

export type BroadcastBodyCheck =
  | { kind: "ok"; body: string }
  | { kind: "empty" }
  | { kind: "too-long" }
  | { kind: "nul" };

// Правила те же, что у сервиса, и проверяются до кадра подтверждения: отказ
// после «Отправить» стоил бы человеку набранного текста, а предпросмотр
// показывал бы то, что заведомо не уйдёт. Окончательную проверку делает
// Notifications, поверхность её не заменяет.
export function checkBroadcastBody(text: string): BroadcastBodyCheck {
  const body = text.trim();
  if (body === "") return { kind: "empty" };
  if (body.length > broadcastBodyLimit) return { kind: "too-long" };
  if (body.includes("\u0000")) return { kind: "nul" };
  return { kind: "ok", body };
}

export function createBroadcasts(
  notifications: Pick<
    Notifications,
    "broadcastToMeetupSubscribers" | "broadcastToCommunity"
  >,
) {
  return async (request: BroadcastRequest): Promise<ExecuteResult> => {
    const meta = rpcMeta(request);
    const broadcast = {
      identityId: request.identity.identityId,
      broadcastId: request.broadcastId,
      body: request.body,
    };
    const result =
      request.audience.kind === "meetup"
        ? await notifications.broadcastToMeetupSubscribers(
            { ...broadcast, meetupId: request.audience.meetupId },
            meta,
          )
        : await notifications.broadcastToCommunity(broadcast, meta);
    if (result.kind === "ok") {
      return result.created
        ? { kind: "broadcast-accepted", audience: request.audience }
        : {
            kind: "broadcast-accepted",
            audience: request.audience,
            repeated: true,
          };
    }
    if (result.kind === "invalid") {
      return {
        kind: "dependency-rejected",
        reason: "invalid",
        message: result.message,
      };
    }
    return { kind: "dependency-rejected", reason: result.kind };
  };
}
