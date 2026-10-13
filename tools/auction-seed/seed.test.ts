import { describe, expect, it } from "vitest";
import type { MeetupSnapshot } from "../../apps/hub-bot/src/surfaces/hub/meetups/port.js";
import type { Catalog } from "./catalog.js";
import { SeedError, type SeedPorts, seedAuction } from "./seed.js";

const catalog: Catalog = {
  meetup: {
    title: "Тестовый аукцион",
    description: "Описание",
    venue: "Онлайн",
    startsAt: { year: 2026, month: 10, day: 31, hours: 19, minutes: 0 },
  },
  lots: [
    {
      title: "С фото",
      description: "",
      image: new Uint8Array([1, 2]),
      startingPriceRubles: 300,
      stepRubles: 50,
    },
    {
      title: "Без фото",
      description: "",
      startingPriceRubles: 100,
      stepRubles: 20,
    },
  ],
};

const draft: MeetupSnapshot = {
  id: "m-1",
  author: "admin",
  title: "",
  description: "",
  venue: "",
  lifecycle: "planned",
  visibility: "hidden",
  version: 1,
  materials: [],
};

type Call = { method: string; args: unknown };

function fakePorts(overrides: Partial<Record<string, { kind: string }>> = {}) {
  const calls: Call[] = [];
  let id = 0;
  let version = draft.version;
  const meetup = (method: string, args: unknown) => {
    calls.push({ method, args });
    const failure = overrides[method];
    if (failure !== undefined) return Promise.resolve(failure as never);
    version += 1;
    return Promise.resolve({
      kind: "ok" as const,
      meetup: { ...draft, version },
    });
  };
  const lot = (method: string, args: unknown) => {
    calls.push({ method, args });
    return Promise.resolve((overrides[method] ?? { kind: "ok" }) as never);
  };
  const ports: SeedPorts = {
    identity: {
      resolve: (input) => {
        calls.push({ method: "resolve", args: input });
        return Promise.resolve(
          (overrides["resolve"] as never) ?? {
            kind: "resolved",
            identityId: "admin",
            rights: ["manage-meetups"],
            blocked: false,
          },
        );
      },
    },
    meetups: {
      createDraft: (person, meetupId) =>
        meetup("createDraft", { person, meetupId }),
      changeAttributes: (_person, snapshot) =>
        meetup("changeAttributes", {
          title: snapshot.title,
          description: snapshot.description,
          venue: snapshot.venue,
        }),
      setSchedule: (_person, _snapshot, schedule) =>
        meetup("setSchedule", schedule),
      publish: (_person, snapshot) =>
        meetup("publish", { version: snapshot.version }),
    },
    auctions: {
      enableAuction: (_person, meetupId) => {
        calls.push({ method: "enableAuction", args: meetupId });
        return Promise.resolve(
          (overrides["enableAuction"] as never) ?? {
            kind: "enabled",
            auctionId: "a-1",
            alreadyExisted: false,
          },
        );
      },
      createLotCard: (_person, card) => lot("createLotCard", card),
      editLotCard: (_person, card) => lot("editLotCard", card),
      addLot: (_person, entry) => lot("addLot", entry),
      scheduleLot: (_person, terms) => lot("scheduleLot", terms),
    },
    newId: () => {
      id += 1;
      return `id-${id}`;
    },
    log: () => {},
  };
  return { ports, calls };
}

describe("наполнение аукциона", () => {
  it("публикует сходку, включает аукцион и заводит лоты по порядку", async () => {
    const { ports, calls } = fakePorts();
    const result = await seedAuction(catalog, 42n, ports);

    expect(calls.map((call) => call.method)).toEqual([
      "resolve",
      "createDraft",
      "changeAttributes",
      "setSchedule",
      "publish",
      "enableAuction",
      "createLotCard",
      "editLotCard",
      "addLot",
      "scheduleLot",
      "createLotCard",
      "addLot",
      "scheduleLot",
    ]);
    expect(calls[0]?.args).toEqual({ telegramUserId: 42n });
    expect(calls[2]?.args).toEqual({
      title: "Тестовый аукцион",
      description: "Описание",
      venue: "Онлайн",
    });
    // Публикация несёт версию, которую вернул предыдущий шаг, а не черновика.
    expect(calls[4]?.args).toEqual({ version: draft.version + 3 });
    expect(result).toEqual({
      meetupId: "m-1",
      auctionId: "a-1",
      lots: [
        { title: "С фото", lotId: "id-3" },
        { title: "Без фото", lotId: "id-6" },
      ],
    });
  });

  it("цена и шаг уходят копейками в рублях, фото — правкой карточки", async () => {
    const { ports, calls } = fakePorts();
    await seedAuction(catalog, 42n, ports);
    const schedule = calls.find((call) => call.method === "scheduleLot");
    expect(schedule?.args).toMatchObject({
      auctionId: "a-1",
      lotId: "id-3",
      startingPrice: { minorUnits: 30_000, currency: "RUB" },
      stepPolicy: {
        kind: "fixed",
        step: { minorUnits: 5_000, currency: "RUB" },
      },
    });
    const photo = calls.find((call) => call.method === "editLotCard");
    expect(photo?.args).toEqual({
      lotId: "id-3",
      title: "С фото",
      description: "",
      image: new Uint8Array([1, 2]),
    });
  });

  it("отказ посреди лотов называет лот и шаг и дальше не идёт", async () => {
    const { ports, calls } = fakePorts({ addLot: { kind: "lots-frozen" } });
    const failure = seedAuction(catalog, 42n, ports);
    await expect(failure).rejects.toThrow(
      "наполнение остановилось на лоте 1, шаг «добавление в аукцион»: lots-frozen",
    );
    await expect(failure).rejects.toBeInstanceOf(SeedError);
    expect(calls.at(-1)?.method).toBe("addLot");
  });

  it("не администратор останавливает до лотов", async () => {
    const { ports, calls } = fakePorts({
      enableAuction: { kind: "not-administrator" },
    });
    await expect(seedAuction(catalog, 42n, ports)).rejects.toThrow(
      "наполнение остановилось на шаге «включение аукциона»: not-administrator",
    );
    expect(calls.some((call) => call.method === "createLotCard")).toBe(false);
  });

  it("недоступный Identity и заблокированный человек — до сходки", async () => {
    const unavailable = fakePorts({
      resolve: {
        kind: "unavailable",
        cause: new Error("connect refused"),
      } as never,
    });
    await expect(seedAuction(catalog, 42n, unavailable.ports)).rejects.toThrow(
      "шаге «разрешение администратора»: unavailable: connect refused",
    );
    expect(unavailable.calls).toHaveLength(1);

    const blocked = fakePorts({
      resolve: {
        kind: "resolved",
        identityId: "admin",
        rights: [],
        blocked: true,
      } as never,
    });
    await expect(seedAuction(catalog, 42n, blocked.ports)).rejects.toThrow(
      "человек заблокирован",
    );
  });
});
