import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import type {
  Administrator,
  AdministratorManager,
  AppointAdministratorResult,
  DismissAdministratorResult,
  IdentityResolver,
} from "../identity/port.js";
import { uuidToToken } from "./meetup-deep-link.js";

// «Управление → Администраторы» (PER-521): список держателей наборов,
// назначение по нику через подтверждение и снятие набора admin. Identity
// подменён одним состоянием: право grant_admins он проверяет сам и отвечает
// отказом значением, как сервис.

const keeperId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const aliceId = "0192f0a0-0000-7000-8000-00000000c001";
const peerId = "0192f0a0-0000-7000-8000-00000000c002";

const MAINTAINER_RIGHTS: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "grant-admins",
];
const ADMIN_RIGHTS: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "manage-members",
  "admit-bidders",
  "manage-meetups",
];

type Person = {
  identityId: string;
  telegramUserId: bigint;
  telegramUsername: string;
  circle: "member" | "guest";
  maintainer: boolean;
  admin: boolean;
};

// Identity администраторов: люди по нику, наборы и право смотрящего. Право
// читается при каждом вызове — тест меняет его между нажатиями.
function fakeIdentity(viewer: { rights: readonly AccessRight[] }) {
  const people: Person[] = [
    {
      identityId: keeperId,
      telegramUserId: 42n,
      telegramUsername: "keeper",
      circle: "member",
      maintainer: true,
      admin: false,
    },
    {
      identityId: aliceId,
      telegramUserId: 43n,
      telegramUsername: "alice",
      circle: "member",
      maintainer: false,
      admin: false,
    },
    {
      identityId: peerId,
      telegramUserId: 44n,
      telegramUsername: "peer",
      circle: "member",
      maintainer: true,
      admin: true,
    },
    {
      identityId: "0192f0a0-0000-7000-8000-00000000c003",
      telegramUserId: 45n,
      telegramUsername: "guest_one",
      circle: "guest",
      maintainer: false,
      admin: false,
    },
  ];
  const rpc: { method: string; args: unknown[] }[] = [];
  const grantor = () => viewer.rights.includes("grant-admins");
  const manager: AdministratorManager = {
    async administrators(...args) {
      rpc.push({ method: "administrators", args });
      if (!grantor()) return { kind: "forbidden" };
      return {
        kind: "ok",
        value: people
          .filter((person) => person.maintainer || person.admin)
          .map(
            (person): Administrator => ({
              identityId: person.identityId,
              telegramUserId: person.telegramUserId,
              telegramUsername: person.telegramUsername,
              maintainer: person.maintainer,
              admin: person.admin,
            }),
          ),
      };
    },
    async appointAdministrator(...args): Promise<AppointAdministratorResult> {
      rpc.push({ method: "appoint", args });
      if (!grantor()) return { kind: "forbidden" };
      const username = args[1].replace(/^@/, "").toLowerCase();
      const person = people.find(
        (candidate) => candidate.telegramUsername === username,
      );
      if (person === undefined) return { kind: "username-unknown" };
      if (person.circle !== "member") return { kind: "not-member" };
      const changed = !person.admin;
      person.admin = true;
      return { kind: "ok", value: { identityId: person.identityId, changed } };
    },
    async dismissAdministrator(...args): Promise<DismissAdministratorResult> {
      rpc.push({ method: "dismiss", args });
      if (!grantor()) return { kind: "forbidden" };
      const person = people.find(
        (candidate) => candidate.identityId === args[1],
      );
      if (person === undefined) return { kind: "identity-unknown" };
      const changed = person.admin;
      person.admin = false;
      return { kind: "ok", value: changed };
    },
  };
  const resolver: IdentityResolver = {
    resolve: async () => ({
      kind: "resolved",
      identityId: keeperId,
      rights: viewer.rights,
      blocked: false,
    }),
  };
  return {
    identity: { ...resolver, ...manager },
    people,
    sent: (method: string) => rpc.filter((call) => call.method === method),
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
        text: "Администраторы",
      },
    } as never,
  };
}

function command(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: 42, is_bot: false, first_name: "tester" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  };
}

type Sent = {
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard: {
      text: string;
      callback_data?: string;
      style?: string;
    }[][];
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
  return (screen.text ?? "").replaceAll(/<\/?b>/g, "");
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

function question(calls: readonly RecordedCall[]) {
  const index = calls.findLastIndex(
    (call) =>
      call.method === "sendMessage" &&
      (call.payload as Sent).reply_markup?.force_reply === true,
  );
  if (index === -1) throw new Error("no question was asked");
  return { payload: calls[index]?.payload as Sent, messageId: 100 + index + 1 };
}

function answer(
  calls: readonly RecordedCall[],
  text: string,
  username?: string,
): Update {
  const asked = question(calls);
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: {
        id: 42,
        is_bot: false,
        first_name: "tester",
        ...(username === undefined ? {} : { username }),
      },
      text,
      reply_to_message: {
        message_id: asked.messageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: asked.payload.text,
        reply_markup: asked.payload.reply_markup,
      } as never,
    },
  };
}

async function started(rights: readonly AccessRight[]) {
  const viewer = { rights };
  const identity = fakeIdentity(viewer);
  const { bot, calls } = createHarness(identity.identity);
  await bot.init();
  return { bot, calls, viewer, ...identity };
}

// Назначение от вопроса до «Да»: ответ ником и нажатие подтверждения.
async function appoint(
  harness: Awaited<ReturnType<typeof started>>,
  text: string,
  // Ник того, кто отвечает, — по нему подтверждение узнаёт назначение себя.
  from?: string,
) {
  await harness.bot.handleUpdate(press("v1:ad:n"));
  await harness.bot.handleUpdate(answer(harness.calls, text, from));
  const confirm = last(harness.calls);
  await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, назначить")));
  return confirm;
}

describe("administrators in the hub bot", () => {
  // Одна видимая группа тоже идёт кнопкой: «Администраторы» стоят в
  // «Участниках» при любых правах (прогон 14.10, №49).
  it("shows a maintainer without the admin preset the group of this item", async () => {
    const harness = await started(MAINTAINER_RIGHTS);

    await harness.bot.handleUpdate(command("/manage"));
    expect(labels(last(harness.calls))).toEqual(["Участники", "‹ Меню"]);

    await harness.bot.handleUpdate(press("v1:manage:g:p"));
    expect(labels(last(harness.calls))).toEqual([
      "Администраторы",
      "‹ Управление",
    ]);
  });

  it("keeps the item from an administrator without grant_admins", async () => {
    const harness = await started(ADMIN_RIGHTS);

    await harness.bot.handleUpdate(press("v1:manage:g:p"));

    expect(labels(last(harness.calls))).not.toContain("Администраторы");
    expect(labels(last(harness.calls))).toContain("Состав сообщества");
  });

  it("lists the holders with their presets and dismisses only admin", async () => {
    const harness = await started(MAINTAINER_RIGHTS);

    await harness.bot.handleUpdate(press("v1:ad:l"));

    const screen = last(harness.calls);
    expect(plain(screen)).toContain("@keeper (ты) · мейнтейнер");
    expect(plain(screen)).toContain("@peer · мейнтейнер, администратор");
    expect(labels(screen)).toEqual([
      "Снять @peer",
      "Назначить",
      "🔄 Обновить",
      "‹ Участники",
    ]);
  });

  it("tells apart two administrators who still carry the same nick", async () => {
    const harness = await started(MAINTAINER_RIGHTS);
    harness.people.push({
      identityId: "0192f0a0-0000-7000-8000-00000000c004",
      telegramUserId: 46n,
      telegramUsername: "Peer",
      circle: "member",
      maintainer: false,
      admin: true,
    });

    await harness.bot.handleUpdate(press("v1:ad:l"));

    expect(labels(last(harness.calls))).toEqual([
      "Снять @peer · id 44",
      "Снять @Peer · id 46",
      "Назначить",
      "🔄 Обновить",
      "‹ Участники",
    ]);
  });

  // Назначение себя говорит на «ты» (прогон 14.10, №47): подтверждение узнаёт
  // свой ник без учёта регистра, итог — свой id в ответе Identity.
  it("appoints the maintainer to admin through the confirmation", async () => {
    const harness = await started(MAINTAINER_RIGHTS);

    const confirm = await appoint(harness, "@Keeper", "keeper");

    expect(plain(confirm)).toContain("Назначить администратором?");
    // Ник — предмет экрана: жирным абзацем без кавычек (PER-594).
    expect(confirm.text).toContain("\n\n<b>@Keeper</b>\n\n");
    expect(plain(confirm)).toContain(
      "Это ты: ты сможешь решать заявки, вести состав и сходки, и тебе придёт сообщение о назначении.",
    );
    expect(harness.sent("appoint")).toHaveLength(1);
    expect(harness.sent("appoint")[0]?.args[1]).toBe("Keeper");
    expect(plain(last(harness.calls))).toContain("Ты назначен администратором");
    expect(plain(last(harness.calls))).toContain(
      "Тебе придёт сообщение о назначении.",
    );
    expect(labels(last(harness.calls))).toEqual(["‹ Администраторы"]);

    await harness.bot.handleUpdate(press("v1:ad:l"));
    expect(plain(last(harness.calls))).toContain(
      "@keeper (ты) · мейнтейнер, администратор",
    );
    expect(labels(last(harness.calls))).toContain("Снять @keeper");
  });

  // Негативный путь №47: другой человек — третье лицо, как раньше.
  it("speaks of another person in the third person", async () => {
    const harness = await started(MAINTAINER_RIGHTS);

    const confirm = await appoint(harness, "alice", "keeper");

    expect(plain(confirm)).toContain(
      "Человек сможет решать заявки, вести состав и сходки, и ему придёт сообщение о назначении.",
    );
    expect(plain(confirm)).not.toContain("Это ты");
    expect(plain(last(harness.calls))).toContain("Администратор назначен");
    expect(plain(last(harness.calls))).toContain(
      "Человеку придёт сообщение о назначении.",
    );
  });

  it("appoints nobody when the confirmation is declined", async () => {
    const harness = await started(MAINTAINER_RIGHTS);
    await harness.bot.handleUpdate(press("v1:ad:n"));
    await harness.bot.handleUpdate(answer(harness.calls, "alice"));

    await harness.bot.handleUpdate(press(dataOf(last(harness.calls), "✖️ Нет")));

    expect(harness.sent("appoint")).toHaveLength(0);
    expect(plain(last(harness.calls))).toContain("Не назначено");
    expect(labels(last(harness.calls))).toEqual([
      "Ввести заново",
      "‹ Администраторы",
    ]);
  });

  it.each([
    ["nobody_here", "Человек ещё не писал боту"],
    ["guest_one", "Не участник сообщества"],
  ])("tells the refusal for %s on its own screen", async (username, text) => {
    const harness = await started(MAINTAINER_RIGHTS);

    await appoint(harness, username);

    expect(plain(last(harness.calls))).toContain(text);
    expect(last(harness.calls).text).toContain(`\n\n<b>@${username}</b>\n\n`);
    expect(labels(last(harness.calls))).toEqual([
      "Ввести заново",
      "‹ Администраторы",
    ]);
    expect(harness.people.filter((person) => person.admin)).toHaveLength(1);
  });

  it("shows a request Identity could not read as a failure, not a bad nick", async () => {
    const viewer = { rights: MAINTAINER_RIGHTS };
    const fake = fakeIdentity(viewer);
    const { bot, calls } = createHarness({
      ...fake.identity,
      appointAdministrator: async () => ({ kind: "invalid" }),
    });
    await bot.init();

    await bot.handleUpdate(press("v1:ad:ay:alice"));

    expect(plain(last(calls))).not.toContain("ник Telegram");
    expect(plain(last(calls))).toContain("Не получилось загрузить данные");
    expect(labels(last(calls))).toEqual(["‹ Администраторы"]);
  });

  it("asks again when the answer is not a username", async () => {
    const harness = await started(MAINTAINER_RIGHTS);
    await harness.bot.handleUpdate(press("v1:ad:n"));

    await harness.bot.handleUpdate(answer(harness.calls, "not a nick"));

    expect(plain(last(harness.calls))).toContain(
      "Это не похоже на ник Telegram",
    );
    expect(harness.sent("appoint")).toHaveLength(0);
  });

  it("dismisses the admin preset of a peer and of oneself", async () => {
    const harness = await started(MAINTAINER_RIGHTS);
    await appoint(harness, "keeper");

    for (const [id, name] of [
      [peerId, "@peer"],
      [keeperId, "@keeper"],
    ] as const) {
      await harness.bot.handleUpdate(press("v1:ad:l"));
      await harness.bot.handleUpdate(
        press(dataOf(last(harness.calls), `Снять ${name}`)),
      );
      const confirm = last(harness.calls);
      expect(plain(confirm)).toContain("Снять администратора?");
      // Человек — предмет экрана: жирным абзацем без кавычек (PER-594).
      expect(confirm.text).toContain(`\n\n<b>${name}`);
      expect(confirm.text).not.toContain("«");
      // Снятие обратимо: «Да» цвета не несёт.
      expect(
        confirm.reply_markup?.inline_keyboard.flat()[0]?.style,
      ).toBeUndefined();
      await harness.bot.handleUpdate(press(dataOf(confirm, "✔️ Да, снять")));
      expect(plain(last(harness.calls))).toContain("Администратор снят");
      expect(harness.sent("dismiss").at(-1)?.args[1]).toBe(id);
    }
    // Мейнтейнеры остались мейнтейнерами: снимается только admin.
    expect(
      harness.people
        .filter((person) => person.maintainer)
        .map((person) => person.admin),
    ).toEqual([false, false]);
  });

  it("passes a forged press to Identity and shows its refusal", async () => {
    const harness = await started(ADMIN_RIGHTS);

    await harness.bot.handleUpdate(press("v1:ad:ay:alice"));
    expect(plain(last(harness.calls))).toContain(
      "Назначать и снимать администраторов может только мейнтейнер",
    );
    await harness.bot.handleUpdate(press(`v1:ad:dy:${uuidToToken(peerId)}`));
    await harness.bot.handleUpdate(press("v1:ad:l"));

    expect(harness.sent("appoint")).toHaveLength(1);
    expect(harness.sent("dismiss")).toHaveLength(1);
    expect(harness.sent("administrators")).toHaveLength(1);
    expect(plain(last(harness.calls))).toContain(
      "Назначать и снимать администраторов может только мейнтейнер",
    );
    expect(
      harness.people.filter((person) => person.admin).map((p) => p.identityId),
    ).toEqual([peerId]);
  });

  it("refuses the question without the right before Identity", async () => {
    const harness = await started(ADMIN_RIGHTS);

    await harness.bot.handleUpdate(press("v1:ad:n"));

    expect(() => question(harness.calls)).toThrow();
    expect(harness.calls.length).toBeGreaterThan(0);
    expect(harness.sent("administrators")).toHaveLength(0);
  });

  it("refuses an old question answered after the right was lost", async () => {
    const harness = await started(MAINTAINER_RIGHTS);
    await harness.bot.handleUpdate(press("v1:ad:n"));
    harness.viewer.rights = ADMIN_RIGHTS;

    await harness.bot.handleUpdate(answer(harness.calls, "alice"));

    expect(plain(last(harness.calls))).toContain(
      "Назначать и снимать администраторов может только мейнтейнер",
    );
    expect(harness.sent("appoint")).toHaveLength(0);
  });
});
