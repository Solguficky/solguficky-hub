import type {
  RenderContext,
  RenderResult,
} from "../../../core/delivery/index.js";
import type { Logger } from "../../../core/logging.js";
import { cursorAtApplication } from "../identity/application-cursor.js";
import type {
  ApplicationCard,
  ApplicationCursor,
  ApplicationQueueRead,
  IdentityAdminResult,
} from "../identity/port.js";
import type { ApplicationQueue, RenderableContent } from "./notification.js";

type AccessRequested = Extract<RenderableContent, { kind: "access-requested" }>;

// Что видит модератор под оповещением о заявке (PER-634): карточку заявки,
// весть о том, что её уже решили, или — без права очереди, без курсора в
// факте или без ответа Identity — один повод, как до PER-634.
export type AccessRequestView =
  | AccessRequested
  | {
      kind: "access-request-card";
      queue: ApplicationQueue;
      application: ApplicationCard;
      // Момент сборки: от него карточка считает возраст заявки.
      shownAtMs: number;
    }
  | { kind: "access-request-decided"; queue: ApplicationQueue };

// Чтение очереди правами получателя: тот же вызов, которым её читает экран
// заявки, поэтому и отказ по праву тот же.
export type ReadApplicationQueue = (
  identityId: string,
  queue: ApplicationQueue,
  after: ApplicationCursor,
  requestId?: string,
) => Promise<IdentityAdminResult<ApplicationQueueRead>>;

// Почему оповещение ушло без тела, хотя курсор был: отказ, который Identity
// не должен был дать, или его недоступность. Отказ по праву сюда не входит —
// это штатный исход.
export type BodyMissing =
  | { kind: "invalid" }
  | { kind: "unavailable"; cause: unknown };

export type AccessRequestRenderOptions = {
  read: ReadApplicationQueue;
  now: () => number;
  onBodyMissing: (reason: BodyMissing, requestId?: string) => void;
};

// Сборка оповещения о заявке. Заявка читается курсором «эта же, если ещё
// открыта»: открытая приходит первой, а решённая — нет, и тогда на её месте
// следующая или ничего. Право получателя проверяет само чтение: потерявший
// право очереди получает повод без тела, а не отказ доставки — о заявке он
// узнал, а решать её уже не ему. Сбой чтения тела тоже не роняет повод, как
// название у вести о лоте: весть ценна вовремя, а повтор на отказе, который
// повтор не изменит, после исчерпания попыток потерял бы её целиком. Такой
// сбой пишется через `onBodyMissing`, чтобы деградация была видна.
export function createAccessRequestRender({
  read,
  now,
  onBodyMissing,
}: AccessRequestRenderOptions): (
  content: AccessRequested,
  context: RenderContext,
) => Promise<RenderResult<AccessRequestView>> {
  return async (content, { recipientId, requestId }) => {
    const { application, queue } = content;
    if (application === undefined) {
      return { kind: "ready", message: content };
    }
    const bare = {
      kind: "ready",
      message: { kind: "access-requested", queue },
    } as const;
    const result = await read(
      recipientId,
      queue,
      cursorAtApplication(application),
      requestId,
    );
    switch (result.kind) {
      case "ok": {
        const card = result.value.card;
        return card?.application.applicationId === application.applicationId
          ? {
              kind: "ready",
              message: {
                kind: "access-request-card",
                queue,
                application: card.application,
                shownAtMs: now(),
              },
            }
          : {
              kind: "ready",
              message: { kind: "access-request-decided", queue },
            };
      }
      case "forbidden":
        return bare;
      case "invalid":
        onBodyMissing({ kind: "invalid" }, requestId);
        return bare;
      case "unavailable":
        onBodyMissing({ kind: "unavailable", cause: result.cause }, requestId);
        return bare;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  };
}

// Запись о теле, которого оповещение не получило. Отказ Identity на курсор,
// собранный ботом, — нарушение инварианта, а не недоступность, и в логе они
// различимы.
export function logBodyMissing(
  logger: Pick<Logger, "warn">,
): (reason: BodyMissing, requestId?: string) => void {
  return (reason, requestId) =>
    logger.warn("access request body unavailable", {
      ...(requestId === undefined ? {} : { request_id: requestId }),
      ...(reason.kind === "invalid"
        ? { error_category: "invariant", error: "application cursor refused" }
        : {
            error_category: "dependency_unavailable",
            error:
              reason.cause instanceof Error
                ? reason.cause.message
                : String(reason.cause),
          }),
    });
}
