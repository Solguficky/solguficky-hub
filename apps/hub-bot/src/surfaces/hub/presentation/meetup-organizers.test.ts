import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { createDispatcher } from "../application/dispatcher.js";
import type {
  IdentityResolver,
  OrganizerCandidateFinder,
  OrganizerCandidateResult,
  OrganizerResolver,
} from "../identity/port.js";
import type { MeetupResult, MeetupSnapshot, Meetups } from "../meetups/port.js";
import { uuidToToken } from "./meetup-deep-link.js";

// «Организаторы» сходки (PER-749; ADR-076, п. 6–8). Meetups подменён одним
// составом с правилами команд из integration.md: право смотрящего, защита
// автора, «последний в составе» и отменённая сходка. Identity — люди по нику:
// поиск отвечает отказом значением, как сервис, и ничего не заводит.

const meetupId = "0192f0a0-0000-7000-8000-00000000e001";
const token = uuidToToken(meetupId);
const leshaId = "0192f0a0-0000-7000-8000-00000000e101";
const mashaId = "0192f0a0-0000-7000-8000-00000000e102";
const ninaId = "0192f0a0-0000-7000-8000-00000000e103";
const adminId = "0192f0a0-0000-7000-8000-00000000e104";
const ghostId = "0192f0a0-0000-7000-8000-00000000e105";

const MEMBER: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "organize-meetups",
];
const ADMIN: readonly AccessRight[] = [...MEMBER, "manage-meetups"];

type Viewer = { identityId: string; rights: readonly AccessRight[] };

const notUsed = async (): Promise<never> => {
  throw new Error("not used");
};

function fakeMeetups(state: {
  meetup: MeetupSnapshot;
  rights: Map<string, readonly AccessRight[]>;
}) {
  const commands: { kind: string; viewer: string; target?: string }[] = [];
  const holds = (id: string, right: AccessRight) =>
    state.rights.get(id)?.includes(right) ?? false;
  const relation = (viewer: string) =>
    holds(viewer, "manage-meetups")
      ? "admin"
      : state.meetup.organizers.includes(viewer) &&
          holds(viewer, "organize-meetups")
        ? "organizer"
        : undefined;
  const ok = (organizers: readonly string[]): MeetupResult => {
    if (organizers !== state.meetup.organizers) {
      state.meetup = {
        ...state.meetup,
        organizers,
        version: state.meetup.version + 1,
      };
    }
    return { kind: "ok", meetup: state.meetup };
  };
  const precondition = (): MeetupResult => ({
    kind: "invalid",
    cause: new Error("failed precondition"),
    precondition: true,
  });
  const meetups: Meetups = {
    listVisible: notUsed,
    listArchived: notUsed,
    createDraft: notUsed,
    async get() {
      return { kind: "ok", meetup: state.meetup };
    },
    changeAttributes: notUsed,
    setSchedule: notUsed,
    publish: notUsed,
    unpublish: notUsed,
    cancel: notUsed,
    markHeld: notUsed,
    schedulePublication: notUsed,
    cancelPublication: notUsed,
    attachMaterial: notUsed,
    removeMaterial: notUsed,
    reorderMaterials: notUsed,
    async appointOrganizer(person, _meetup, identityId) {
      commands.push({
        kind: "appoint",
        viewer: person.identityId,
        target: identityId,
      });
      if (relation(person.identityId) === undefined)
        return { kind: "forbidden" };
      if (state.meetup.organizers.includes(identityId))
        return ok(state.meetup.organizers);
      if (state.meetup.lifecycle === "cancelled") return precondition();
      if (!holds(identityId, "organize-meetups")) return precondition();
      return ok([...state.meetup.organizers, identityId]);
    },
    async dismissOrganizer(person, _meetup, identityId) {
      commands.push({
        kind: "dismiss",
        viewer: person.identityId,
        target: identityId,
      });
      const viewer = relation(person.identityId);
      if (viewer === undefined) return { kind: "forbidden" };
      if (!state.meetup.organizers.includes(identityId))
        return ok(state.meetup.organizers);
      if (identityId === state.meetup.author && viewer !== "admin")
        return { kind: "forbidden" };
      if (state.meetup.organizers.length === 1 && viewer !== "admin")
        return precondition();
      return ok(state.meetup.organizers.filter((id) => id !== identityId));
    },
    async leaveOrganizers(person) {
      commands.push({ kind: "leave", viewer: person.identityId });
      if (!state.meetup.organizers.includes(person.identityId))
        return ok(state.meetup.organizers);
      if (
        state.meetup.organizers.length === 1 &&
        relation(person.identityId) !== "admin"
      )
        return precondition();
      return ok(
        state.meetup.organizers.filter((id) => id !== person.identityId),
      );
    },
  };
  return { meetups, commands };
}

// Люди Identity: ник и права. Ник называется, только если человек держит
// organize-meetups и стоит в составе (ADR-076, п. 10).
const people: Record<string, { username: string; outcome?: string }> = {
  [leshaId]: { username: "lesha" },
  [mashaId]: { username: "masha" },
  [ninaId]: { username: "nina" },
  [adminId]: { username: "admin" },
};

function fakeIdentity(
  viewer: Viewer,
  state: {
    meetup: MeetupSnapshot;
    rights: Map<string, readonly AccessRight[]>;
  },
) {
  const searches: string[] = [];
  const resolver: IdentityResolver = {
    resolve: async () => ({
      kind: "resolved",
      identityId: viewer.identityId,
      rights: viewer.rights,
      blocked: false,
    }),
  };
  const organizers: OrganizerResolver = {
    async resolveOrganizerUsername(_viewer, contact) {
      const person = people[contact.identityId];
      return person !== undefined &&
        state.meetup.organizers.includes(contact.identityId) &&
        (state.rights.get(contact.identityId)?.includes("organize-meetups") ??
          false)
        ? { kind: "resolved", telegramUsername: person.username }
        : { kind: "not-found" };
    },
  };
  const refusals: Record<string, OrganizerCandidateResult> = {
    nobody: { kind: "username-unknown" },
    twice: { kind: "username-unresolved" },
    gwen: { kind: "not-member" },
    judy: { kind: "blocked" },
    norights: { kind: "no-organize-right" },
    down: { kind: "unavailable", cause: new Error("identity down") },
  };
  const finder: OrganizerCandidateFinder = {
    async findOrganizerCandidate(actor, telegramUsername) {
      searches.push(telegramUsername);
      const rights = state.rights.get(actor.identityId) ?? [];
      if (
        !rights.includes("organize-meetups") &&
        !rights.includes("manage-meetups")
      )
        return { kind: "forbidden" };
      const username = telegramUsername.toLowerCase();
      const refused = refusals[username];
      if (refused !== undefined) return refused;
      const found = Object.entries(people).find(
        ([, person]) => person.username === username,
      );
      return found === undefined
        ? { kind: "username-unknown" }
        : {
            kind: "ok",
            value: {
              identityId: found[0],
              telegramUsername: found[1].username,
            },
          };
    },
  };
  return { identity: { ...resolver, ...organizers, ...finder }, searches };
}

function meetup(overrides: Partial<MeetupSnapshot> = {}): MeetupSnapshot {
  return {
    id: meetupId,
    author: leshaId,
    title: "Настолки",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    version: 3,
    materials: [],
    organizers: [leshaId, mashaId],
    ...overrides,
  };
}

async function started(as: Viewer, snapshot: MeetupSnapshot = meetup()) {
  const viewer = { ...as };
  const state = {
    meetup: snapshot,
    rights: new Map<string, readonly AccessRight[]>([
      [leshaId, MEMBER],
      [mashaId, MEMBER],
      [ninaId, MEMBER],
      [adminId, ADMIN],
      [ghostId, []],
    ]),
  };
  const { meetups, commands } = fakeMeetups(state);
  const { identity, searches } = fakeIdentity(viewer, state);
  const harness = createHarness(identity, createDispatcher(meetups));
  await harness.bot.init();
  return {
    ...harness,
    viewer,
    state,
    commands,
    searches,
    switchTo(next: Viewer) {
      viewer.identityId = next.identityId;
      viewer.rights = next.rights;
    },
  };
}

function press(data: string): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        text: "Сходка",
      },
    } as never,
  };
}

type Sent = {
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard: { text: string; callback_data?: string }[][];
  };
};

function last(calls: readonly RecordedCall[]): Sent {
  const screen = calls
    .filter((call) => ["editMessageText", "sendMessage"].includes(call.method))
    .map((call) => call.payload as Sent)
    .at(-1);
  if (screen === undefined) throw new Error("nothing was shown");
  return screen;
}

function plain(screen: Sent): string {
  return (screen.text ?? "").replaceAll(/<\/?[bi]>/g, "");
}

function labels(screen: Sent): string[] {
  return (screen.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.text);
}

function dataOf(screen: Sent, text: string): string {
  const found = screen.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function answer(calls: readonly RecordedCall[], text: string): Update {
  const index = calls.findLastIndex(
    (call) =>
      call.method === "sendMessage" &&
      (call.payload as Sent).reply_markup?.force_reply === true,
  );
  if (index === -1) throw new Error("no question was asked");
  const asked = calls[index]?.payload as Sent;
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      text,
      reply_to_message: {
        message_id: 100 + index + 1,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: asked.text,
        reply_markup: asked.reply_markup,
      } as never,
    },
  };
}

const lesha = { identityId: leshaId, rights: MEMBER };
const masha = { identityId: mashaId, rights: MEMBER };
const nina = { identityId: ninaId, rights: MEMBER };
const admin = { identityId: adminId, rights: ADMIN };

describe("meetup organizers in the hub bot", () => {
  it("opens the roster from the card of an organizer", async () => {
    const harness = await started(lesha);

    await harness.bot.handleUpdate(press(`v1:view:${token}`));
    const card = last(harness.calls);
    expect(labels(card)).toContain("🛠 Организаторы");

    await harness.bot.handleUpdate(press(dataOf(card, "🛠 Организаторы")));
    const screen = last(harness.calls);
    expect(plain(screen)).toContain("Организаторы\nНастолки");
    expect(plain(screen)).toContain("• ты · автор");
    expect(plain(screen)).toContain("• @masha");
    // Себе — «Выйти», а не «Снять».
    expect(labels(screen)).toEqual([
      "Снять @masha",
      "Добавить",
      "Выйти",
      "‹ Сходка",
    ]);
  });

  it("keeps the entry from a member outside the roster", async () => {
    const harness = await started(nina);

    await harness.bot.handleUpdate(press(`v1:view:${token}`));
    expect(labels(last(harness.calls))).not.toContain("🛠 Организаторы");

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    expect(plain(last(harness.calls))).toContain(
      "Это может только организатор сходки или администратор.",
    );
  });

  // Критерий PER-749: соорганизатор не видит «Снять» у автора, а поддельное
  // нажатие получает отказ и до Meetups не доходит.
  it("hides dismissing the author from a co-organizer", async () => {
    const harness = await started(masha);

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    const screen = last(harness.calls);
    expect(plain(screen)).toContain("• @lesha · автор");
    expect(labels(screen)).not.toContain("Снять @lesha");
    expect(labels(screen)).toEqual(["Добавить", "Выйти", "‹ Сходка"]);
  });

  it("refuses a co-organizer's forged press dismissing the author before Meetups", async () => {
    const harness = await started(masha);

    const forged = `v1:mo:dy:${token}:${uuidToToken(leshaId)}`;
    for (const data of [`v1:mo:dq:${token}:${uuidToToken(leshaId)}`, forged]) {
      await harness.bot.handleUpdate(press(data));
      expect(plain(last(harness.calls))).toContain(
        "Автора снимает только администратор.",
      );
    }
    expect(harness.commands).toEqual([]);
    expect(harness.state.meetup.organizers).toEqual([leshaId, mashaId]);
  });

  it("lets the administrator dismiss the author", async () => {
    const harness = await started(admin);

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    const screen = last(harness.calls);
    expect(labels(screen)).toEqual([
      "Снять @lesha",
      "Снять @masha",
      "Добавить",
      "‹ Сходка",
    ]);

    await harness.bot.handleUpdate(press(dataOf(screen, "Снять @lesha")));
    const confirm = last(harness.calls);
    expect(plain(confirm)).toContain("Снять организатора?");
    await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, снять")));

    expect(plain(last(harness.calls))).toContain("Организатор снят");
    expect(harness.state.meetup.organizers).toEqual([mashaId]);
  });

  // Критерий PER-749: организатор назначает участника по нику, и у того на
  // карточке появляются кнопки управления.
  it("appoints a member by username who then manages the meetup", async () => {
    const harness = await started(lesha);

    await harness.bot.handleUpdate(press(`v1:view:${token}`));
    // До назначения у Нины управления нет.
    harness.switchTo(nina);
    await harness.bot.handleUpdate(press(`v1:view:${token}`));
    expect(labels(last(harness.calls))).not.toContain("🛠 Изменить");
    harness.switchTo(lesha);

    await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
    await harness.bot.handleUpdate(answer(harness.calls, " @Nina"));
    const confirm = last(harness.calls);
    expect(plain(confirm)).toContain("Назначить организатором?");
    expect(plain(confirm)).toContain("@nina");
    expect(harness.commands).toEqual([]);

    await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, назначить")));
    expect(plain(last(harness.calls))).toContain("Организатор назначен");
    expect(harness.commands).toEqual([
      { kind: "appoint", viewer: leshaId, target: ninaId },
    ]);

    harness.switchTo(nina);
    await harness.bot.handleUpdate(press(`v1:view:${token}`));
    const card = last(harness.calls);
    expect(labels(card)).toContain("🛠 Изменить");
    expect(labels(card)).toContain("🛠 Организаторы");
  });

  // Критерий PER-749: каждый отказ Identity — свой кадр, и команда Meetups
  // не уходит: состав не меняется.
  it.each([
    ["nobody", "Ник не найден"],
    ["twice", "Ник не определяет человека"],
    ["gwen", "Этот человек не в сообществе"],
    ["judy", "Профиль заблокирован"],
    ["norights", "У человека нет права вести сходки"],
  ])(
    "refuses %s with its own frame and keeps the roster",
    async (nick, text) => {
      const harness = await started(lesha);

      await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
      await harness.bot.handleUpdate(answer(harness.calls, nick));

      const screen = last(harness.calls);
      expect(plain(screen)).toContain(text);
      expect(plain(screen)).toContain(`@${nick}`);
      expect(labels(screen)).toEqual(["Ввести заново", "‹ Организаторы"]);
      expect(harness.searches).toEqual([nick]);
      expect(harness.commands).toEqual([]);
      expect(harness.state.meetup.organizers).toEqual([leshaId, mashaId]);
    },
  );

  it("asks again for a username that is not a Telegram username", async () => {
    const harness = await started(lesha);

    await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
    await harness.bot.handleUpdate(answer(harness.calls, "not a nick"));

    expect(plain(last(harness.calls))).toContain(
      "Это не похоже на ник Telegram",
    );
    expect(harness.searches).toEqual([]);
  });

  // Ответ на вопрос после рестарта: сходка едет в кнопке вопроса.
  it("takes the answer after a restart from the question button", async () => {
    const first = await started(lesha);
    await first.bot.handleUpdate(press(`v1:mo:a:${token}`));
    const reply = answer(first.calls, "nina");

    const second = await started(lesha);
    await second.bot.handleUpdate(reply);

    expect(plain(last(second.calls))).toContain("Назначить организатором?");
  });

  // Критерий PER-749: «Выйти» последнего в составе — кадр отказа.
  it("refuses the last organizer leaving the roster", async () => {
    const harness = await started(lesha, meetup({ organizers: [leshaId] }));

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    await harness.bot.handleUpdate(press(dataOf(last(harness.calls), "Выйти")));
    const confirm = last(harness.calls);
    expect(plain(confirm)).toContain("Выйти из организаторов?");
    await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, выйти")));

    expect(plain(last(harness.calls))).toContain("Ты последний в составе.");
    expect(harness.state.meetup.organizers).toEqual([leshaId]);
  });

  it("lets an organizer leave when others stay", async () => {
    const harness = await started(masha);

    await harness.bot.handleUpdate(press(`v1:mo:lq:${token}`));
    await harness.bot.handleUpdate(
      press(dataOf(last(harness.calls), "✔️ Да, выйти")),
    );

    const screen = last(harness.calls);
    expect(plain(screen)).toContain("Ты вышел из организаторов");
    expect(labels(screen)).toEqual(["‹ Сходка"]);
    expect(harness.state.meetup.organizers).toEqual([leshaId]);
  });

  // Человек, которого Identity не называет, остаётся в составе своей строкой,
  // и администратор может его снять.
  it("names a person without a username by place and offers dismissing them", async () => {
    const harness = await started(
      admin,
      meetup({ organizers: [leshaId, ghostId] }),
    );

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    const screen = last(harness.calls);
    expect(plain(screen)).toContain("• организатор №2, без ника");
    expect(labels(screen)).toContain("Снять №2");
  });

  it("does not offer appointing in a cancelled meetup", async () => {
    const harness = await started(lesha, meetup({ lifecycle: "cancelled" }));

    await harness.bot.handleUpdate(press(`v1:mo:l:${token}`));
    expect(labels(last(harness.calls))).not.toContain("Добавить");

    await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
    expect(plain(last(harness.calls))).toContain("Сходка отменена.");
  });
});

// «Выйти из организаторов» под вестью о назначении — след: подтверждение
// приходит новым сообщением, а весть остаётся в истории (ADR-076, п. 8).
describe("leaving from the appointment notice", () => {
  it("opens the leave confirmation as a new message", async () => {
    const harness = await started(masha);

    await harness.bot.handleUpdate(press(`v1:t:mo:lq:${token}`));

    const sent = harness.calls.filter((call) => call.method === "sendMessage");
    expect(plain(sent.at(-1)?.payload as Sent)).toContain(
      "Выйти из организаторов?",
    );
    expect(harness.commands).toEqual([]);
  });
});

// Находки ревью PER-749: повтор и гонки команд состава отвечают исходом, а не
// отказом, и сбой Identity оставляет путь повторить.
describe("meetup organizers on repeats and races", () => {
  it("answers a repeated leave as already left, not as forbidden", async () => {
    const harness = await started(masha);
    await harness.bot.handleUpdate(press(`v1:mo:ly:${token}`));
    expect(harness.state.meetup.organizers).toEqual([leshaId]);

    await harness.bot.handleUpdate(press(`v1:mo:ly:${token}`));
    expect(plain(last(harness.calls))).toContain("Ты уже не в составе");
    await harness.bot.handleUpdate(press(`v1:mo:lq:${token}`));
    expect(plain(last(harness.calls))).toContain("Ты уже не в составе");
  });

  it("answers dismissing an author who already left as already out", async () => {
    const harness = await started(masha, meetup({ organizers: [mashaId] }));

    await harness.bot.handleUpdate(
      press(`v1:mo:dy:${token}:${uuidToToken(leshaId)}`),
    );

    expect(plain(last(harness.calls))).toContain("Уже не в составе");
  });

  it("offers to send the username again when Identity does not answer", async () => {
    const harness = await started(lesha);

    await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
    await harness.bot.handleUpdate(answer(harness.calls, "down"));

    const screen = last(harness.calls);
    expect(plain(screen)).toContain("Не получилось проверить ник");
    expect(labels(screen)).toEqual(["Ввести заново", "‹ Организаторы"]);
    expect(harness.commands).toEqual([]);
  });

  it("names the cancellation when the meetup is cancelled before the appointment", async () => {
    const harness = await started(lesha);
    await harness.bot.handleUpdate(press(`v1:mo:a:${token}`));
    await harness.bot.handleUpdate(answer(harness.calls, "nina"));
    const confirm = last(harness.calls);
    harness.state.meetup = { ...harness.state.meetup, lifecycle: "cancelled" };

    await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, назначить")));

    expect(plain(last(harness.calls))).toContain("Сходка отменена.");
  });

  it("says nobody is left when the administrator leaves the last place", async () => {
    const harness = await started(admin, meetup({ organizers: [adminId] }));

    await harness.bot.handleUpdate(press(`v1:mo:ly:${token}`));

    expect(plain(last(harness.calls))).toContain(
      "В составе никого: сходку ведёт администратор.",
    );
    expect(harness.state.meetup.organizers).toEqual([]);
  });
});
