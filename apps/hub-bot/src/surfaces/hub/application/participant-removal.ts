import type { LotView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  AuctionFailure,
  RemovalPreview,
  RemovalPreviewResult,
} from "../auction/port.js";
import type {
  ExecuteResult,
  ParticipantRemovalRequest,
  RemovalForecast,
  RemovalLot,
  RemovalPerson,
  RemovalRefusal,
  RemovalTargetInput,
} from "./types.js";

// Снятие участника с лота администратором (ADR-072, PER-659): кого снять,
// подтверждение с предпросмотром и снятие. Своего состояния нет: лот, человек
// и номер лота предпросмотра едут в кнопке. Право решает Auction у Meetups на
// каждом вызове; пускает сюда край — держателя права вести аукцион.
//
// Снятие необратимо, и «Да» несёт номер лота, на котором решён
// предпросмотр: лот, который ушёл от него, Auction не меняет, а пульт
// показывает предпросмотр заново (ADR-072, дополнение 2026-10-21). Повтор
// того же «Да» после принятого снятия упирается в тот же номер и снова
// ничего не снимает.

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

// Снимать можно в онлайн-торгах и с удержанного лота до заморозки состава
// (ADR-072, п. 4). Заморозку лот не знает — её отказ приходит от Auction.
// Решение по снимку — для экрана: команду решает Auction.
function refusalOf(lot: LotView): RemovalRefusal | undefined {
  const status = lot.status;
  switch (status.kind) {
    case "trading":
      return status.phase === "online" ? undefined : "not-in-online-phase";
    case "held":
      return undefined;
    case "draft":
    case "scheduled":
      return "not-in-prebidding";
    case "sold":
    case "unsold":
    case "withdrawn":
      return "lot-not-open";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function lotOf(lot: LotView): RemovalLot {
  return {
    lotId: lot.lotId,
    auctionId: lot.auctionId,
    ...(lot.card?.title === undefined ? {} : { title: lot.card.title }),
  };
}

export function createParticipantRemoval(consoles: AuctionConsoles) {
  type Found =
    | { kind: "ok"; lot: LotView }
    | { kind: "refused"; result: ExecuteResult };

  // Аукцион кнопки — у лота: рядом с лотом, человеком и номером он в 64
  // байта не помещается. Лот, которого Auction не отдаёт, — подделка или
  // лот удалённого аукциона.
  async function lotRead(
    request: ParticipantRemovalRequest,
    lotId: string,
    atLeastVersion?: number,
  ): Promise<Found> {
    const found = await consoles.floorLot(
      request.identity,
      { lotId, ...(atLeastVersion === undefined ? {} : { atLeastVersion }) },
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        return found;
      case "not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
  }

  const refused = (lot: LotView, reason: RemovalRefusal): ExecuteResult => ({
    kind: "removal-outcome",
    lot: lotOf(lot),
    note: { kind: "refused", reason },
  });

  // Имя человека и лидера — одним вызовом. Отказ имён экран не роняет:
  // строка остаётся без имени, а идентификатор человеку не показывается.
  async function namesOf(
    request: ParticipantRemovalRequest,
    auctionId: string,
    ids: readonly (string | undefined)[],
  ): Promise<Readonly<Record<string, string>>> {
    const participantIds = [
      ...new Set(ids.filter((id): id is string => id !== undefined)),
    ];
    if (participantIds.length === 0) return {};
    const found = await consoles.displayNames(
      request.identity,
      { auctionId, participantIds },
      rpcMeta(request),
    );
    return found.kind === "ok" ? found.names : {};
  }

  function forecastOf(
    preview: Pick<RemovalPreview, "price" | "leaderId" | "extendedDeadline">,
    names: Readonly<Record<string, string>>,
  ): RemovalForecast {
    const leaderName =
      preview.leaderId === undefined ? undefined : names[preview.leaderId];
    return {
      price: preview.price,
      leader:
        preview.leaderId === undefined
          ? "none"
          : leaderName === undefined
            ? {}
            : { name: leaderName },
      ...(preview.extendedDeadline === undefined
        ? {}
        : { extendedDeadline: preview.extendedDeadline }),
    };
  }

  // Отказ предпросмотра или снятия, общий у двух: право и сходка — кадрами
  // пульта, остальное — исходом над лотом.
  function refusal(
    lot: LotView,
    answer: Exclude<RemovalPreviewResult, { kind: "ok" }>,
  ): ExecuteResult {
    switch (answer.kind) {
      case "refused":
        return refused(lot, answer.reason);
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "meetup-cancelled":
        return meetupCancelled;
      default:
        return failed(answer);
    }
  }

  // Кого снять: участники лота, ещё не снятые, в порядке первой ставки.
  async function view(
    request: Extract<ParticipantRemovalRequest, { intent: "view-lot-removal" }>,
  ): Promise<ExecuteResult> {
    const found = await lotRead(request, request.lotId);
    if (found.kind === "refused") return found.result;
    const { lot } = found;
    const closed = refusalOf(lot);
    if (closed !== undefined) return refused(lot, closed);
    const listed = await consoles.lotParticipants(
      request.identity,
      { auctionId: lot.auctionId, lotId: lot.lotId },
      rpcMeta(request),
    );
    if (listed.kind !== "ok") return failed(listed);
    const people: RemovalPerson[] = listed.participants
      .filter((each) => !each.removed)
      .map((each) => ({
        participantId: each.participantId,
        ...(each.name === undefined ? {} : { name: each.name }),
      }));
    if (people.length === 0) {
      return {
        kind: "removal-outcome",
        lot: lotOf(lot),
        note: { kind: "no-participants" },
      };
    }
    return {
      kind: "removal-people",
      lot: lotOf(lot),
      people,
      page: request.page,
    };
  }

  // Предпросмотр: тот же решатель лота без записи (ADR-072). `changed` —
  // подтверждение задаётся заново после `lot-changed`.
  async function confirm(
    request: ParticipantRemovalRequest,
    lot: LotView,
    target: RemovalTargetInput,
    changed: boolean,
  ): Promise<ExecuteResult> {
    const preview = await consoles.previewParticipantRemoval(
      request.identity,
      { auctionId: lot.auctionId, ...target },
      rpcMeta(request),
    );
    if (preview.kind !== "ok") return refusal(lot, preview);
    const names = await namesOf(request, lot.auctionId, [
      target.participantId,
      preview.preview.leaderId,
    ]);
    const name = names[target.participantId];
    return {
      kind: "removal-confirm",
      lot: lotOf(lot),
      person: {
        participantId: target.participantId,
        ...(name === undefined ? {} : { name }),
      },
      forecast: forecastOf(preview.preview, names),
      version: preview.preview.version,
      ...(changed ? { changed: true as const } : {}),
    };
  }

  async function prepare(
    request: Extract<
      ParticipantRemovalRequest,
      { intent: "prepare-participant-removal" }
    >,
  ): Promise<ExecuteResult> {
    const found = await lotRead(request, request.target.lotId);
    if (found.kind === "refused") return found.result;
    return confirm(request, found.lot, request.target, false);
  }

  // «Да». Повтора автоматом нет: снятие, ответ на которое потерялся, могло
  // пройти, и «Повторить» ведёт к предпросмотру, а не к команде.
  async function remove(
    request: Extract<
      ParticipantRemovalRequest,
      { intent: "remove-participant" }
    >,
  ): Promise<ExecuteResult> {
    const found = await lotRead(request, request.target.lotId);
    if (found.kind === "refused") return found.result;
    const { lot } = found;
    const removed = await consoles.removeParticipant(
      request.identity,
      {
        auctionId: lot.auctionId,
        ...request.target,
        expectedVersion: request.version,
        opId: request.opId,
      },
      rpcMeta(request),
    );
    switch (removed.kind) {
      case "ok":
        break;
      case "lot-changed":
        return confirm(request, lot, request.target, true);
      default:
        return refusal(lot, removed);
    }
    // Лот после снятия — не старее номера из ответа: чтение отстаёт от
    // команды. Чтение отказало — исход снятия важнее строки о лидере.
    const after = await lotRead(request, lot.lotId, removed.lotVersion);
    const status = after.kind === "ok" ? after.lot.status : undefined;
    const leading =
      status?.kind === "trading" || status?.kind === "held"
        ? status
        : undefined;
    const names = await namesOf(request, lot.auctionId, [
      request.target.participantId,
      leading?.leaderId,
    ]);
    const name = names[request.target.participantId];
    return {
      kind: "removal-outcome",
      lot: lotOf(lot),
      note: {
        kind: "removed",
        ...(name === undefined ? {} : { name }),
        ...(leading === undefined
          ? {}
          : {
              after: forecastOf(
                {
                  price: leading.currentPrice,
                  ...(leading.leaderId === undefined
                    ? {}
                    : { leaderId: leading.leaderId }),
                },
                names,
              ),
            }),
      },
      lotVersion: removed.lotVersion,
    };
  }

  return async (request: ParticipantRemovalRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-lot-removal":
        return view(request);
      case "prepare-participant-removal":
        return prepare(request);
      case "remove-participant":
        return remove(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
