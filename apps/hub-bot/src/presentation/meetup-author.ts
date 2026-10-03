import type { Dispatcher } from "../application/dispatcher.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  MeetupAuthor,
  Person,
} from "../application/types.js";
import type { OrganizerResolver } from "../identity/port.js";
import { type RpcMetadata, rpcMeta } from "../rpc-metadata.js";

// Результаты, которые представление рисует карточкой сходки. Строка автора
// появляется во всех них, а не только при просмотре: иначе она пропадала бы из
// карточки после правки, публикации или смены статуса (PER-404).
const cardKinds = [
  "meetup-card",
  "published",
  "publication-scheduled",
  "publication-unavailable",
  "meetup-updated",
  "meetup-state-changed",
] as const;

type CardResult = Extract<ExecuteResult, { kind: (typeof cardKinds)[number] }>;

function isCardResult(result: ExecuteResult): result is CardResult {
  return (cardKinds as readonly string[]).includes(result.kind);
}

// Identity зовёт представление, а не приложение (apps/hub-bot/AGENTS.md):
// диспетчер про Identity не знает, и автора к его результату дописывает эта
// обёртка. Ник спрашивается только по автору из снимка, который Meetups уже
// отдал этому зрителю: видимость решает Meetups, и карточка, которую зрителю
// видеть нельзя, сюда не доходит. Самому автору Identity не нужна — он видит
// «вы». Любой отказ Identity оставляет карточку без строки автора, но саму
// карточку не роняет: сходка читается из Meetups и остаётся верной.
export function withMeetupAuthor(
  dispatcher: Dispatcher,
  organizers: Partial<OrganizerResolver>,
): Dispatcher {
  return {
    async execute(request: ExecuteRequest) {
      const result = await dispatcher.execute(request);
      if (request.intent === "start" || !isCardResult(result)) return result;
      const author = await nameAuthor(
        organizers,
        request.identity,
        result.meetup.author,
        rpcMeta(request),
      );
      return author === undefined ? result : { ...result, author };
    },
  };
}

async function nameAuthor(
  organizers: Partial<OrganizerResolver>,
  viewer: Person,
  authorId: string,
  meta: RpcMetadata | undefined,
): Promise<MeetupAuthor | undefined> {
  if (authorId === viewer.identityId) return { kind: "self" };
  if (organizers.resolveOrganizerUsername === undefined || authorId === "") {
    return undefined;
  }
  const resolved = await organizers.resolveOrganizerUsername(
    viewer,
    authorId,
    meta,
  );
  return resolved.kind === "resolved" && resolved.telegramUsername !== undefined
    ? { kind: "organizer", telegramUsername: resolved.telegramUsername }
    : undefined;
}
