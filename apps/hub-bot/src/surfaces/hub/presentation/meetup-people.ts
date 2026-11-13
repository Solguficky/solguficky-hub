import { type RpcMetadata, rpcMeta } from "../../../core/rpc-metadata.js";
import type { Dispatcher } from "../application/dispatcher.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  MeetupContact,
  MeetupPeople,
  MeetupViewer,
  Person,
} from "../application/types.js";
import type { OrganizerResolver } from "../identity/port.js";
import type { MeetupSnapshot } from "../meetups/port.js";

// Результаты, которые представление рисует карточкой сходки. Люди карточки и
// отношение смотрящего появляются во всех них, а не только при просмотре:
// иначе строки пропадали бы из карточки после правки, публикации или смены
// статуса (PER-404).
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

/**
 * Отношение смотрящего к сходке (ADR-076, п. 4): держатель `manage-meetups`
 * ведёт любую сходку, организатор — ту, в чьём составе стоит, пока держит
 * `organize-meetups`. Решает бот по снимку, который Meetups уже отдал
 * смотрящему, без отдельного вызова: команду всё равно проверит сервис, а
 * кнопка, которая ведёт в отказ, хуже её отсутствия.
 */
export function meetupViewer(
  person: Person,
  meetup: Pick<MeetupSnapshot, "organizers">,
): MeetupViewer {
  const administrator = person.rights.includes("manage-meetups");
  const organizer =
    person.rights.includes("organize-meetups") &&
    meetup.organizers.includes(person.identityId);
  return { manages: administrator || organizer, administrator };
}

/**
 * Право, без которого отношения к сходке нет: заводить сходку и вести свою —
 * `organize-meetups`, любую — `manage-meetups` (ADR-076, п. 1–4). Им бот
 * пропускает «Создать сходку» и ответ на вопрос, заданный с карточки, а саму
 * сходку решает отношение `meetupViewer` и сервис на команде.
 */
export function canOrganizeMeetups(person: Pick<Person, "rights">): boolean {
  return (
    person.rights.includes("organize-meetups") ||
    person.rights.includes("manage-meetups")
  );
}

// Identity зовёт представление, а не приложение (apps/hub-bot/AGENTS.md):
// диспетчер про Identity не знает, и людей карточки к его результату дописывает
// эта обёртка вместе с отношением смотрящего. Ник спрашивается только по людям
// из снимка, который Meetups уже отдал этому смотрящему, и с id сходки: Identity
// подтверждает человека у Meetups (ADR-076, п. 10). Самого смотрящего
// Identity не спрашивают — он видит «ты». Любой отказ Identity убирает только
// этого человека из строк, но карточку не роняет: сходка читается из Meetups и
// остаётся верной.
export function withMeetupPeople(
  dispatcher: Dispatcher,
  organizers: Partial<OrganizerResolver>,
): Dispatcher {
  return {
    async execute(request: ExecuteRequest) {
      const result = await dispatcher.execute(request);
      if (request.intent === "start") return result;
      // Черновик формы строк людей не несёт, и Identity ради него не
      // спрашивают, но возврат с него зависит от отношения: «Скрытые» или
      // «Сходки».
      if (result.kind === "draft") {
        return {
          ...result,
          viewer: meetupViewer(request.identity, result.meetup),
        };
      }
      if (!isCardResult(result)) return result;
      const people = await namePeople(
        organizers,
        request.identity,
        result.meetup,
        rpcMeta(request),
      );
      return {
        ...result,
        people,
        viewer: meetupViewer(request.identity, result.meetup),
      };
    },
  };
}

async function namePeople(
  organizers: Partial<OrganizerResolver>,
  viewer: Person,
  meetup: MeetupSnapshot,
  meta: RpcMetadata | undefined,
): Promise<MeetupPeople> {
  // Автор обычно стоит и в составе: один человек — один вызов.
  const ids = [
    ...new Set(
      [meetup.author, ...meetup.organizers].filter(
        (id) => id !== "" && id !== viewer.identityId,
      ),
    ),
  ];
  const answers = await Promise.all(
    ids.map(
      async (identityId) =>
        [
          identityId,
          await nameContact(organizers, viewer, meetup.id, identityId, meta),
        ] as const,
    ),
  );
  const named = new Map<string, MeetupContact>(
    answers.flatMap(([id, contact]) =>
      contact === undefined ? [] : [[id, contact] as const],
    ),
  );
  // Себя смотрящий видит без вызова, но по тому же правилу, что остальных:
  // Identity называет только держателя `organize-meetups` (ADR-076, п. 10), и
  // человек, оставшийся в составе без права, ни организатором, ни автором
  // себя на карточке не видит.
  const self: MeetupContact | undefined = viewer.rights.includes(
    "organize-meetups",
  )
    ? { kind: "self" }
    : undefined;
  const contactOf = (id: string): MeetupContact | undefined =>
    id === viewer.identityId ? self : named.get(id);
  const author = meetup.author === "" ? undefined : contactOf(meetup.author);
  const roster = meetup.organizers.map((identityId) => {
    const contact = contactOf(identityId);
    return contact === undefined ? { identityId } : { identityId, contact };
  });
  return {
    ...(author === undefined ? {} : { author }),
    organizers: roster.flatMap((entry) =>
      entry.contact === undefined ? [] : [entry.contact],
    ),
    roster,
  };
}

async function nameContact(
  organizers: Partial<OrganizerResolver>,
  viewer: Person,
  meetupId: string,
  identityId: string,
  meta: RpcMetadata | undefined,
): Promise<MeetupContact | undefined> {
  if (organizers.resolveOrganizerUsername === undefined) return undefined;
  const resolved = await organizers.resolveOrganizerUsername(
    viewer,
    { meetupId, identityId },
    meta,
  );
  return resolved.kind === "resolved" && resolved.telegramUsername !== undefined
    ? { kind: "username", telegramUsername: resolved.telegramUsername }
    : undefined;
}
