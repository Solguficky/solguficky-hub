import type { Chat, Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  botInfo,
  createCapturingLogger,
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";
import type {
  AttachMaterialRequest,
  MeetupSnapshot,
  Meetups,
} from "../meetups/port.js";
import { communityChatCommands } from "./commands.js";
import { createCommunityChat } from "./community-chat.js";
import {
  attachedMaterialId,
  parseAttachArgument,
} from "./community-whisper-materials.js";
import { meetupDeepLinkPayload, uuidToToken } from "./meetup-deep-link.js";

// `/attach` в чате сообщества (PER-885, PER-914; ADR-078, п. 5 и
// дополнение 2026-11-19): ссылка и название идут в любом порядке, годится
// только ссылка на сообщение этого чата или публичного канала. Шёпот с
// кнопками сходок, где человек правит материалы, и нажатие, которое
// прикрепляет ссылку тем же `attach-material`, что личка, — через настоящий
// диспетчер над Meetups в памяти, поэтому материал виден и в карточке сходки
// в боте.

const community = -4012345678;
const person = { id: 42, is_bot: false, first_name: "tester" } as const;
const hubBot = { id: 999, is_bot: true, first_name: "hub" } as const;
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const otherId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab0000";
const today = { year: 2026, month: 11, day: 14 } as const;
// Публичный канал: ссылка из чата сообщества принимается (PER-914). Ссылку
// в другой закрытый чат (`t.me/c/<другой чат>/…`) проверяют отдельно.
const link = "https://t.me/solguficky/15";

function group(id: number): Chat.GroupChat {
  return { id, type: "group", title: "чат" };
}

function snapshot(
  id: string,
  title: string,
  options: {
    day?: number;
    organizers?: readonly string[];
    visibility?: "visible" | "hidden";
    lifecycle?: MeetupSnapshot["lifecycle"];
  } = {},
): MeetupSnapshot {
  return {
    id,
    author: otherId,
    title,
    description: "",
    venue: "",
    lifecycle: options.lifecycle ?? "planned",
    visibility: options.visibility ?? "visible",
    version: 3,
    materials: [],
    organizers: options.organizers ?? [identityId],
    schedule: {
      year: 2026,
      month: 11,
      day: options.day ?? 20,
      hours: 19,
      minutes: 0,
    },
  };
}

const own = snapshot("11111111-1111-4111-8111-111111111111", "Настолки", {
  day: 15,
});
const foreign = snapshot("22222222-2222-4222-8222-222222222222", "Прогулка", {
  day: 22,
  organizers: [otherId],
});
const hidden = snapshot("33333333-3333-4333-8333-333333333333", "Черновик", {
  visibility: "hidden",
});
const past = snapshot("44444444-4444-4444-8444-444444444444", "Прошлая", {
  day: 1,
});
const cancelled = snapshot("55555555-5555-4555-8555-555555555555", "Отмена", {
  lifecycle: "cancelled",
});

type Setup = {
  meetups?: readonly MeetupSnapshot[];
  rights?: readonly AccessRight[];
  // Первая запись принята Meetups, но ответ не дошёл: бот видит таймаут.
  timeoutAfterFirstAttach?: boolean;
};

function attachHarness(setup: Setup = {}) {
  const stored = new Map(
    (setup.meetups ?? [own, foreign]).map((meetup) => [meetup.id, meetup]),
  );
  const reads = { list: 0, get: 0 };
  let timeouts = setup.timeoutAfterFirstAttach === true ? 1 : 0;
  const attachMaterial = vi.fn(async (request: AttachMaterialRequest) => {
    const current = stored.get(request.meetupId);
    if (current === undefined) return { kind: "forbidden" as const };
    if (current.version !== request.expectedVersion) {
      return { kind: "conflict" as const };
    }
    const next = {
      ...current,
      version: current.version + 1,
      materials: [...current.materials, request.material],
    };
    stored.set(next.id, next);
    if (timeouts > 0) {
      timeouts -= 1;
      return { kind: "timeout" as const, cause: new Error("deadline") };
    }
    return { kind: "ok" as const, meetup: next };
  });
  const meetups = {
    listVisible: async () => {
      reads.list += 1;
      return {
        kind: "ok" as const,
        meetups: [...stored.values()].map((meetup) => ({
          id: meetup.id,
          title: meetup.title,
          visibility: meetup.visibility,
          ...(meetup.schedule === undefined
            ? {}
            : {
                schedule: {
                  year: meetup.schedule.year,
                  month: meetup.schedule.month,
                  day: meetup.schedule.day,
                },
              }),
        })),
      };
    },
    get: async (_person: unknown, id: string) => {
      reads.get += 1;
      const found = stored.get(id);
      return found === undefined
        ? { kind: "not-found" as const }
        : { kind: "ok" as const, meetup: found };
    },
    attachMaterial,
  } as unknown as Meetups;
  const resolve = vi.fn<IdentityResolver["resolve"]>(async () => ({
    kind: "resolved",
    identityId,
    rights: setup.rights ?? ["access-hub", "organize-meetups"],
    blocked: false,
  }));
  const { logger } = createCapturingLogger();
  const communityChat = createCommunityChat({
    chatId: community,
    commands: communityChatCommands,
    logger,
  });
  const harnessed = createHarness(
    { resolve },
    createDispatcher(meetups),
    [],
    undefined,
    undefined,
    () => today,
    { communityChat },
  );
  return { ...harnessed, attachMaterial, stored, reads };
}

const commandDate = Math.floor(Date.now() / 1_000);

function invisibleCommand(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 0,
      ephemeral_message_id: 7,
      date: commandDate,
      chat: group(community),
      from: person,
      receiver_user: hubBot,
      text,
    },
  } as Update;
}

// Нажатие на шёпоте `/attach`: Telegram приносит с ним команду, на которую
// шёпот ответил, в `reply_to_message` (RFC-003, прогон 2026-11-19).
function attachPress(
  data: string,
  // `null` — нажатие без команды: её удалили или кнопку подделали.
  command: {
    text: string;
    from?: { id: number; is_bot: boolean; first_name: string };
  } | null = {
    text: `/attach@${botInfo.username} ${link} Фото со сходки`,
  },
): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "press-1",
      chat_instance: "chat-1",
      from: person,
      data,
      message: {
        message_id: 0,
        ephemeral_message_id: 8,
        date: commandDate,
        chat: group(community),
        from: hubBot,
        text: "Прикрепить материал",
        ...(command === null
          ? {}
          : {
              reply_to_message: {
                message_id: 0,
                ephemeral_message_id: 7,
                date: commandDate,
                chat: group(community),
                from: command.from ?? person,
                text: command.text,
              },
            }),
      },
    },
  } as unknown as Update;
}

function privatePress(data: string): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "press-2",
      chat_instance: "chat-2",
      from: person,
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: person.id, type: "private", first_name: "tester" },
        text: "Сходки",
      },
    },
  } as unknown as Update;
}

type Key = { text: string; url?: string; callback_data?: string };
type Shown = { text: string; reply_markup?: { inline_keyboard: Key[][] } };

function keys(shown: Shown): Key[] {
  return (shown.reply_markup?.inline_keyboard ?? []).flat();
}

function whisper(calls: readonly RecordedCall[]): Shown {
  const sent = calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => call.payload as unknown as Shown)
    .at(-1);
  if (sent === undefined) throw new Error("шёпота нет");
  return sent;
}

function lastEdit(calls: readonly RecordedCall[]): Shown {
  const edited = calls
    .filter((call) => call.method === "editEphemeralMessageText")
    .map((call) => call.payload as unknown as Shown)
    .at(-1);
  if (edited === undefined) throw new Error("шёпот не правился");
  return edited;
}

const pick = (meetup: MeetupSnapshot, version = meetup.version) =>
  `v1:w:att:${uuidToToken(meetup.id)}:${version}`;

describe("attach a chat message to a meetup from the community chat", () => {
  it("offers only the nearest meetups where the person edits materials", async () => {
    const { bot, calls } = attachHarness({
      meetups: [own, foreign, hidden, past, cancelled],
    });
    await bot.init();
    await bot.handleUpdate(invisibleCommand(`/attach ${link} Фото со сходки`));
    const shown = whisper(calls);
    expect(shown.text).toBe(
      `<b>Прикрепить материал</b>\n\nСсылка: ${link}\nНазвание: Фото со сходки\n\nК какой сходке прикрепить?`,
    );
    expect(keys(shown)).toEqual([
      { text: "15 ноября · Настолки", callback_data: pick(own) },
      {
        text: "Сходки в боте ↗",
        url: `https://t.me/${botInfo.username}?start=meetups`,
      },
    ]);
  });

  // Критерий приёмки PER-914: ссылка и название в любом порядке дают один
  // и тот же шёпот — и текст, и кнопки.
  it("reads the link and the title in either order", async () => {
    const titleFirst = attachHarness();
    await titleFirst.bot.init();
    await titleFirst.bot.handleUpdate(
      invisibleCommand(`/attach Фото со сходки ${link}`),
    );
    const titleWhisper = whisper(titleFirst.calls);
    const linkFirst = attachHarness();
    await linkFirst.bot.init();
    await linkFirst.bot.handleUpdate(
      invisibleCommand(`/attach ${link} Фото со сходки`),
    );
    const linkWhisper = whisper(linkFirst.calls);
    expect(titleWhisper.text).toBe(linkWhisper.text);
    expect(titleWhisper.reply_markup).toEqual(linkWhisper.reply_markup);
  });

  it("offers an administrator every nearest published meetup", async () => {
    const { bot, calls } = attachHarness({
      rights: ["access-hub", "manage-meetups"],
      meetups: [own, foreign, hidden, past],
    });
    await bot.init();
    await bot.handleUpdate(invisibleCommand(`/attach ${link} Фото`));
    expect(keys(whisper(calls)).map((key) => key.text)).toEqual([
      "15 ноября · Настолки",
      "22 ноября · Прогулка",
      "Сходки в боте ↗",
    ]);
  });

  // Отношение известно только по снимку: десять чужих сходок впереди не
  // скрывают ту, что человек ведёт.
  it("finds the meetup the person runs behind ten meetups of others", async () => {
    const others = Array.from({ length: 11 }, (_, index) =>
      snapshot(
        `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
        `Чужая ${index}`,
        { day: 15, organizers: [otherId] },
      ),
    );
    const mine = snapshot("88888888-8888-4888-8888-888888888888", "Своя", {
      day: 25,
    });
    const { bot, calls } = attachHarness({ meetups: [...others, mine] });
    await bot.init();
    await bot.handleUpdate(invisibleCommand(`/attach ${link} Фото`));
    expect(keys(whisper(calls)).map((key) => key.text)).toEqual([
      "25 ноября · Своя",
      "Сходки в боте ↗",
    ]);
  });

  it("keeps a long meetup title within the button limit", async () => {
    const long = snapshot(own.id, "Очень ".repeat(20), { day: 15 });
    const { bot, calls } = attachHarness({ meetups: [long] });
    await bot.init();
    await bot.handleUpdate(invisibleCommand(`/attach ${link} Фото`));
    const [first] = keys(whisper(calls));
    expect(first?.text.length).toBeLessThanOrEqual(64);
    expect(first?.text.endsWith("…")).toBe(true);
  });

  it("attaches the link on a press and shows it in the meetup card in the bot", async () => {
    const { bot, calls, attachMaterial, stored } = attachHarness();
    await bot.init();
    await bot.handleUpdate(attachPress(pick(own)));
    expect(attachMaterial).toHaveBeenCalledTimes(1);
    expect(attachMaterial.mock.calls[0]?.[0]).toMatchObject({
      person: { identityId },
      meetupId: own.id,
      expectedVersion: own.version,
      material: {
        title: "Фото со сходки",
        source: { kind: "message-link", url: link },
      },
    });
    const edited = lastEdit(calls);
    expect(edited.text).toBe(
      "<b>Прикреплено к «Настолки»</b>\n\nМатериал «Фото со сходки» — в «Материалах» карточки сходки.",
    );
    expect(keys(edited)).toEqual([
      {
        text: "Открыть сходку ↗",
        url: `https://t.me/${botInfo.username}?start=${meetupDeepLinkPayload(own.id)}`,
      },
    ]);
    expect(stored.get(own.id)?.materials).toHaveLength(1);
    calls.length = 0;
    await bot.handleUpdate(privatePress(`v1:view:${uuidToToken(own.id)}`));
    const card = JSON.stringify(calls.map((call) => call.payload));
    expect(card).toContain("Материалы (1)");
  });

  it("attaches once when the same button is pressed again", async () => {
    const { bot, calls, attachMaterial, stored } = attachHarness();
    await bot.init();
    await bot.handleUpdate(attachPress(pick(own)));
    await bot.handleUpdate(attachPress(pick(own)));
    expect(attachMaterial).toHaveBeenCalledTimes(1);
    expect(stored.get(own.id)?.materials).toHaveLength(1);
    expect(lastEdit(calls).text).toContain("Прикреплено к «Настолки»");
  });

  it("derives the material id from the command and the meetup", () => {
    const command = {
      name: "attach",
      argument: "",
      ephemeralMessageId: 7,
      sentAt: 1_000,
    };
    const first = attachedMaterialId(community, command, own.id);
    expect(attachedMaterialId(community, command, own.id)).toBe(first);
    expect(attachedMaterialId(community, command, foreign.id)).not.toBe(first);
    expect(
      attachedMaterialId(community, { ...command, sentAt: 2_000 }, own.id),
    ).not.toBe(first);
  });

  // Человек без права вести сходки кнопок не видит, и Meetups не читается.
  it("tells a person without meetup rights there is nowhere to attach", async () => {
    const { bot, calls, attachMaterial, reads } = attachHarness({
      rights: ["access-hub"],
    });
    await bot.init();
    await bot.handleUpdate(invisibleCommand(`/attach ${link} Фото`));
    const shown = whisper(calls);
    expect(shown.text).toContain(
      "Нет ближайших сходок, к которым ты прикрепляешь материалы.",
    );
    expect(shown.text).toContain(
      "К прошедшей сходке материал прикрепляется в боте",
    );
    expect(keys(shown).map((key) => key.text)).toEqual(["Сходки в боте ↗"]);
    expect(reads).toEqual({ list: 0, get: 0 });
    calls.length = 0;
    await bot.handleUpdate(attachPress(pick(own)));
    expect(attachMaterial).not.toHaveBeenCalled();
  });

  it("hints the format on a broken link, an empty title or a bare command, without Meetups", async () => {
    const { bot, calls, reads } = attachHarness();
    await bot.init();
    for (const [text, reason] of [
      ["/attach", "Напиши после команды ссылку на сообщение"],
      ["/attach Фото со сходки", "Нужна ссылка на сообщение"],
      ["/attach https://example.com/1 Фото", "Нужна ссылка на сообщение"],
      [
        "/attach https://t.me/c/1234567890/42 Тест",
        "Нужна ссылка на сообщение этого чата",
      ],
      [
        `/attach ${link} Фото https://t.me/c/1234567890/42`,
        "В команде несколько ссылок",
      ],
      [`/attach ${link}`, "К ссылке допиши название материала."],
      [`/attach ${link} ${"я".repeat(201)}`, "Название длиннее 200 символов"],
    ] as const) {
      await bot.handleUpdate(invisibleCommand(text));
      const shown = whisper(calls);
      expect(shown.text).toContain(reason);
      expect(shown.text).toContain(
        "Например: /attach Фото со сходки https://t.me/solguficky/15",
      );
      expect(shown.reply_markup).toBeUndefined();
    }
    expect(reads).toEqual({ list: 0, get: 0 });
  });

  // Подделанная кнопка: чужая сходка, скрытая, прошедшая, отменённая,
  // несуществующая и мусор вместо токена.
  it("attaches nothing on a forged press of a meetup the whisper could not offer", async () => {
    const { bot, calls, attachMaterial, records } = attachHarness({
      meetups: [own, foreign, hidden, past, cancelled],
    });
    await bot.init();
    for (const data of [
      pick(foreign),
      pick(hidden),
      pick(past),
      pick(cancelled),
      `v1:w:att:${uuidToToken("77777777-7777-4777-8777-777777777777")}:1`,
      "v1:w:att:not-a-token:1",
      `v1:w:att:${uuidToToken(own.id)}:x`,
    ]) {
      await bot.handleUpdate(attachPress(data));
    }
    expect(attachMaterial).not.toHaveBeenCalled();
    expect(keys(lastEdit(calls)).map((key) => key.text)).toEqual([
      "15 ноября · Настолки",
      "Сходки в боте ↗",
    ]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "community whisper action refused",
        fields: expect.objectContaining({ error: "meetup is not attachable" }),
      }),
    );
  });

  it("attaches nothing on a press without the person's own command", async () => {
    const { bot, calls, attachMaterial } = attachHarness();
    await bot.init();
    await bot.handleUpdate(attachPress(pick(own), null));
    await bot.handleUpdate(
      attachPress(pick(own), {
        text: `/attach ${link} Чужое`,
        from: { ...person, id: 7 },
      }),
    );
    expect(attachMaterial).not.toHaveBeenCalled();
    expect(lastEdit(calls).text).toContain("Этот выбор устарел.");
  });

  it("attaches nothing on a press whose command carries a foreign private chat link", async () => {
    const { bot, calls, attachMaterial, reads } = attachHarness();
    await bot.init();
    await bot.handleUpdate(
      attachPress(pick(own), {
        text: "/attach https://t.me/c/1234567890/42 Тест",
      }),
    );
    expect(attachMaterial).not.toHaveBeenCalled();
    expect(reads).toEqual({ list: 0, get: 0 });
    expect(lastEdit(calls).text).toContain("Этот выбор устарел.");
  });

  it("asks to pick again when the meetup changed after the whisper", async () => {
    const { bot, calls, attachMaterial, stored } = attachHarness();
    await bot.init();
    await bot.handleUpdate(attachPress(pick(own, own.version - 1)));
    expect(attachMaterial).toHaveBeenCalledTimes(1);
    expect(stored.get(own.id)?.materials).toHaveLength(0);
    const edited = lastEdit(calls);
    expect(edited.text).toContain(
      "Сходка только что изменилась — выбери её ещё раз.",
    );
    expect(keys(edited)[0]?.callback_data).toBe(pick(own));
  });

  // Исход записи неизвестен: повтор команды дал бы новый id и второй
  // материал, поэтому шёпот оставляет кнопку той же сходки с тем же id.
  it("keeps the meetup button when the write times out, and a press again attaches once", async () => {
    const { bot, calls, records, stored } = attachHarness({
      timeoutAfterFirstAttach: true,
    });
    await bot.init();
    await bot.handleUpdate(attachPress(pick(own)));
    const edited = lastEdit(calls);
    expect(edited.text).toContain(
      "Не получилось прикрепить. Нажми сходку ещё раз — второй раз материал не прикрепится.",
    );
    expect(keys(edited).map((key) => key.text)).toEqual([
      "15 ноября · Настолки",
      "Сходки в боте ↗",
    ]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "material attach rejected",
        fields: expect.objectContaining({
          use_case: "update_meetup",
          screen: "whisper-attach",
        }),
      }),
    );
    await bot.handleUpdate(attachPress(pick(own)));
    expect(lastEdit(calls).text).toContain("Прикреплено к «Настолки»");
    expect(stored.get(own.id)?.materials).toHaveLength(1);
  });

  it("turns off the link preview in the whisper", async () => {
    const { bot, calls } = attachHarness();
    await bot.init();
    await bot.handleUpdate(
      invisibleCommand("/attach https://t.me/solguficky/15 Пост"),
    );
    expect(
      calls.find((call) => call.method === "sendMessage")?.payload,
    ).toMatchObject({ link_preview_options: { is_disabled: true } });
  });
});

describe("parseAttachArgument", () => {
  it("reads the link and the title in either order", () => {
    expect(parseAttachArgument(`${link} Фото со сходки`, community)).toEqual({
      kind: "ok",
      url: link,
      title: "Фото со сходки",
    });
    expect(parseAttachArgument(`Фото со сходки ${link}`, community)).toEqual({
      kind: "ok",
      url: link,
      title: "Фото со сходки",
    });
    expect(
      parseAttachArgument("t.me/solguficky/15 Итоги\nвстречи", community),
    ).toEqual({
      kind: "ok",
      url: "https://t.me/solguficky/15",
      title: "Итоги\nвстречи",
    });
  });

  it("accepts a link to the community chat or a public channel only", () => {
    expect(
      parseAttachArgument("https://t.me/c/4012345678/42 Тест", community),
    ).toEqual({
      kind: "ok",
      url: "https://t.me/c/4012345678/42",
      title: "Тест",
    });
    expect(
      parseAttachArgument("https://t.me/c/1234567890/42 Тест", community),
    ).toEqual({ kind: "hint", reason: "chat" });
  });

  it("keeps the title limit of the private chat", () => {
    expect(
      parseAttachArgument(`${link} ${"я".repeat(200)}`, community).kind,
    ).toBe("ok");
    expect(
      parseAttachArgument(`${link} ${"я".repeat(201)}`, community),
    ).toEqual({
      kind: "hint",
      reason: "long",
    });
  });

  it("refuses several links instead of guessing which one is the source", () => {
    expect(
      parseAttachArgument(
        `${link} Фото https://t.me/c/1234567890/42`,
        community,
      ),
    ).toEqual({ kind: "hint", reason: "many" });
  });

  it("keeps a middle link from adding a character to the title", () => {
    expect(parseAttachArgument(`Фото ${link} сходки`, community)).toEqual({
      kind: "ok",
      url: link,
      title: "Фото сходки",
    });
    expect(
      parseAttachArgument(`Фото ${link} ${"я".repeat(195)}`, community).kind,
    ).toBe("ok");
  });

  it("reads a basic group id that merely starts with -100 as its own chat", () => {
    const basic = -1001234567;
    expect(
      parseAttachArgument("Фото https://t.me/c/1001234567/42", basic),
    ).toEqual({
      kind: "ok",
      url: "https://t.me/c/1001234567/42",
      title: "Фото",
    });
    expect(
      parseAttachArgument("Фото https://t.me/c/1234567/42", basic),
    ).toEqual({ kind: "hint", reason: "chat" });
  });

  it("converts a supergroup id numerically without a leading zero", () => {
    expect(
      parseAttachArgument("Фото https://t.me/c/123456789/42", -1000123456789),
    ).toEqual({
      kind: "ok",
      url: "https://t.me/c/123456789/42",
      title: "Фото",
    });
    expect(
      parseAttachArgument("Фото https://t.me/c/1234567890/42", -1001234567890),
    ).toEqual({
      kind: "ok",
      url: "https://t.me/c/1234567890/42",
      title: "Фото",
    });
  });
});
