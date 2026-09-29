import type { OrganizerResolver } from "../identity/port.js";
import type { RpcMetadata } from "../rpc-metadata.js";
import type { ExecuteResult, MeetupAuthor, Person } from "./types.js";

// Результаты, которые представление рисует карточкой сходки. Строка автора
// появляется во всех них, а не только при просмотре: иначе она пропадала бы из
// карточки после правки, публикации или смены статуса (PER-404).
type CardResult = Extract<
  ExecuteResult,
  {
    kind:
      | "meetup-card"
      | "published"
      | "publication-scheduled"
      | "publication-unavailable"
      | "meetup-updated"
      | "meetup-state-changed";
  }
>;

function isCardResult(result: ExecuteResult): result is CardResult {
  switch (result.kind) {
    case "meetup-card":
    case "published":
    case "publication-scheduled":
    case "publication-unavailable":
    case "meetup-updated":
    case "meetup-state-changed":
      return true;
    default:
      return false;
  }
}

// Ник спрашивается только по автору из снимка, который Meetups уже отдал этому
// зрителю: видимость сходки решает Meetups, и сюда не доходит карточка, которую
// зрителю видеть нельзя. Самому автору Identity не нужна — он видит «вы».
// Любой отказ Identity оставляет карточку без строки автора, но саму карточку
// не роняет: сходка читается из Meetups и остаётся верной.
export function createAuthorNaming(organizers: OrganizerResolver | undefined) {
  return async (
    result: ExecuteResult,
    viewer: Person,
    meta: RpcMetadata | undefined,
  ): Promise<ExecuteResult> => {
    if (!isCardResult(result)) return result;
    const author = await nameAuthor(
      organizers,
      viewer,
      result.meetup.author,
      meta,
    );
    return author === undefined ? result : { ...result, author };
  };
}

async function nameAuthor(
  organizers: OrganizerResolver | undefined,
  viewer: Person,
  authorId: string,
  meta: RpcMetadata | undefined,
): Promise<MeetupAuthor | undefined> {
  if (authorId === viewer.identityId) return { kind: "self" };
  if (organizers === undefined || authorId === "") return undefined;
  const resolved = await organizers.resolveOrganizerUsername(
    viewer,
    authorId,
    meta,
  );
  return resolved.kind === "resolved" && resolved.telegramUsername !== undefined
    ? { kind: "organizer", telegramUsername: resolved.telegramUsername }
    : undefined;
}
