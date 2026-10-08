import { describe, expect, it } from "vitest";
import type {
  AddLotResult,
  LotAdministration,
  LotCardResult,
  LotReadResult,
  ScheduleLotResult,
} from "../auction/port.js";
import type { LotView } from "../auction-ui/index.js";
import { createDispatcher } from "./dispatcher.js";
import { parseRubles } from "./lot-form.js";
import type { NewLotId } from "./types.js";

// Форма лота администратора (PER-319) через диспетчер: что уходит в Auction на
// каждый ответ и чем форма отвечает на его отказы. Auction подменён записью
// вызовов; ответ, которого тест не задал, — успех.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
// Форму идентификатора нового лота держит край (`new-lot-id.ts`); юзкейсу она
// безразлична, поэтому тест берёт тот же идентификатор под брендом.
const newLot = lotId as NewLotId;
const opId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
const admin = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: ["admin", "public"],
};

const drafted: LotView = {
  lotId,
  auctionId,
  version: 1,
  card: { title: "Ваза", description: "Синяя." },
  proxyEnabled: false,
  status: { kind: "draft" },
};

function fakeLots(
  answers: {
    create?: LotCardResult;
    edit?: LotCardResult;
    add?: AddLotResult;
    schedule?: ScheduleLotResult;
    read?: LotReadResult;
  } = {},
) {
  const calls: { method: keyof LotAdministration; args: unknown }[] = [];
  const port: LotAdministration = {
    async createLotCard(_person, card) {
      calls.push({ method: "createLotCard", args: card });
      return answers.create ?? { kind: "ok" };
    },
    async editLotCard(_person, card) {
      calls.push({ method: "editLotCard", args: card });
      return answers.edit ?? { kind: "ok" };
    },
    async addLot(_person, lot) {
      calls.push({ method: "addLot", args: lot });
      return answers.add ?? { kind: "ok" };
    },
    async scheduleLot(_person, terms) {
      calls.push({ method: "scheduleLot", args: terms });
      return answers.schedule ?? { kind: "ok" };
    },
    async getLot(_person, id) {
      calls.push({ method: "getLot", args: id });
      return answers.read ?? { kind: "ok", lot: drafted };
    },
  };
  const dispatcher = createDispatcher(
    undefined,
    undefined,
    undefined,
    undefined,
    port,
  );
  return { dispatcher, calls, methods: () => calls.map((call) => call.method) };
}

describe("rubles of the lot form", () => {
  it.each([
    ["1500", 1500],
    [" 5 000 ", 5000],
    ["5 000", 5000],
    ["5 000", 5000],
    ["0005000", 5000],
    ["1", 1],
    ["9999999", 9_999_999],
  ])("reads %j as %d whole rubles", (raw, rubles) => {
    expect(parseRubles(raw)).toEqual({ kind: "ok", rubles });
  });

  it.each(["", "дорого", "1500.50", "1,5", "-5", "1e3", "100 ₽", "５００"])(
    "refuses %j as not a whole number of rubles",
    (raw) => {
      expect(parseRubles(raw)).toEqual({
        kind: "rejected",
        reason: "amount-format",
      });
    },
  );

  it.each(["0", "000", "10000000"])("refuses %j as out of range", (raw) => {
    expect(parseRubles(raw)).toEqual({
      kind: "rejected",
      reason: "amount-range",
    });
  });
});

describe("lot form", () => {
  it("writes the card of a new lot, adds it to the auction and shows the form from the answers", async () => {
    const { dispatcher, calls } = fakeLots();

    const result = await dispatcher.execute({
      identity: admin,
      intent: "create-lot",
      auctionId,
      lotId: newLot,
      title: "  Ваза  ",
      opId,
    });

    expect(calls).toEqual([
      {
        method: "createLotCard",
        args: { lotId, title: "Ваза", description: "" },
      },
      { method: "addLot", args: { auctionId, lotId, opId } },
    ]);
    // Read model лот ещё не знает: экран собран без чтения.
    expect(result).toEqual({
      kind: "lot-form",
      lot: {
        lotId,
        auctionId,
        title: "Ваза",
        description: "",
        hasImage: false,
        terms: { kind: "unset" },
      },
      saved: "created",
    });
  });

  it("renames the card left by an interrupted answer instead of refusing the new title", async () => {
    const { dispatcher, calls, methods } = fakeLots({
      create: { kind: "card-conflict" },
      read: { kind: "not-found" },
    });

    const result = await dispatcher.execute({
      identity: admin,
      intent: "create-lot",
      auctionId,
      lotId: newLot,
      title: "Ваза синяя",
      opId,
    });

    expect(methods()).toEqual([
      "createLotCard",
      "getLot",
      "editLotCard",
      "addLot",
    ]);
    expect(calls[2]?.args).toEqual({
      lotId,
      title: "Ваза синяя",
      description: "",
    });
    expect(result).toMatchObject({ kind: "lot-form", saved: "created" });
  });

  it("keeps the description and the terms of a lot the interrupted answer did add", async () => {
    const { dispatcher, calls } = fakeLots({
      create: { kind: "card-conflict" },
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          fixedStep: { minorUnits: 10_000, currency: "RUB" },
          status: {
            kind: "scheduled",
            startingPrice: { minorUnits: 150_000, currency: "RUB" },
          },
        },
      },
    });

    const result = await dispatcher.execute({
      identity: admin,
      intent: "create-lot",
      auctionId,
      lotId: newLot,
      title: "Ваза синяя",
      opId,
    });

    expect(calls[2]).toEqual({
      method: "editLotCard",
      args: { lotId, title: "Ваза синяя", description: "Синяя." },
    });
    expect(result).toEqual({
      kind: "lot-form",
      lot: {
        lotId,
        auctionId,
        title: "Ваза синяя",
        description: "Синяя.",
        hasImage: false,
        terms: {
          kind: "set",
          startingPrice: { minorUnits: 150_000, currency: "RUB" },
          step: { minorUnits: 10_000, currency: "RUB" },
        },
      },
      saved: "text",
    });
  });

  it("asks the title again when Auction calls it empty and adds no lot", async () => {
    const { dispatcher, methods } = fakeLots({
      create: { kind: "empty-title" },
    });

    const result = await dispatcher.execute({
      identity: admin,
      intent: "create-lot",
      auctionId,
      lotId: newLot,
      title: "   ",
      opId,
    });

    expect(result).toEqual({
      kind: "lot-ask",
      question: { kind: "new", auctionId, lotId },
      error: "empty-title",
    });
    expect(methods()).toEqual(["createLotCard"]);
  });

  it.each([
    [{ create: { kind: "not-admin" } } as const, "not-administrator"],
    [{ add: { kind: "not-administrator" } } as const, "not-administrator"],
    [{ add: { kind: "lots-frozen" } } as const, "lots-frozen"],
    [{ add: { kind: "auction-not-found" } } as const, "auction-not-found"],
  ])("answers the refusal %j of a new lot as %s", async (answers, reason) => {
    const { dispatcher } = fakeLots(answers);

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "create-lot",
        auctionId,
        lotId: newLot,
        title: "Ваза",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-refused", reason });
  });

  it("passes a failure of Auction on as a failure, so the answer can be sent again", async () => {
    const { dispatcher } = fakeLots({
      add: { kind: "timeout", cause: new Error("no answer") },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "create-lot",
        auctionId,
        lotId: newLot,
        title: "Ваза",
        opId,
      }),
    ).resolves.toEqual({ kind: "dependency-rejected", reason: "timeout" });
  });

  it("shows the price and the single step of a scheduled lot and closes them once it trades", async () => {
    const scheduled = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          fixedStep: { minorUnits: 10_000, currency: "RUB" },
          status: {
            kind: "scheduled",
            startingPrice: { minorUnits: 150_000, currency: "RUB" },
          },
        },
      },
    });
    const trading = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          status: {
            kind: "trading",
            currentPrice: { minorUnits: 150_000, currency: "RUB" },
            phase: "online",
          },
        },
      },
    });

    await expect(
      scheduled.dispatcher.execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
      }),
    ).resolves.toEqual({
      kind: "lot-form",
      lot: {
        lotId,
        auctionId,
        title: "Ваза",
        description: "Синяя.",
        hasImage: false,
        terms: {
          kind: "set",
          startingPrice: { minorUnits: 150_000, currency: "RUB" },
          step: { minorUnits: 10_000, currency: "RUB" },
        },
      },
    });
    await expect(
      trading.dispatcher.execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
      }),
    ).resolves.toMatchObject({ lot: { terms: { kind: "closed" } } });
  });

  it("answers a lot Auction does not know with a refusal", async () => {
    const { dispatcher } = fakeLots({ read: { kind: "not-found" } });

    await expect(
      dispatcher.execute({ identity: admin, intent: "view-lot-form", lotId }),
    ).resolves.toEqual({ kind: "lot-refused", reason: "lot-not-found", lotId });
  });

  it("replaces one text of the card and resends the other as it is stored", async () => {
    const { dispatcher, calls } = fakeLots();

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-text",
      lotId,
      field: "description",
      value: " Синяя, с трещиной. ",
    });

    expect(calls.at(-1)).toEqual({
      method: "editLotCard",
      args: { lotId, title: "Ваза", description: "Синяя, с трещиной." },
    });
    expect(result).toMatchObject({
      kind: "lot-form",
      lot: { title: "Ваза", description: "Синяя, с трещиной." },
      saved: "text",
    });
  });

  it("replaces the image of the card and resends both texts as they are stored", async () => {
    const { dispatcher, calls } = fakeLots();
    const image = new Uint8Array([0xff, 0xd8, 0xff]);

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-image",
      lotId,
      image,
    });

    expect(calls.at(-1)).toEqual({
      method: "editLotCard",
      args: { lotId, title: "Ваза", description: "Синяя.", image },
    });
    expect(result).toMatchObject({
      kind: "lot-form",
      lot: { hasImage: true },
      saved: "image",
    });
  });

  it.each([
    [
      { kind: "image-too-large", maxBytes: 2_097_152 } as const,
      { error: "image-too-large", maxImageBytes: 2_097_152 },
    ],
    [{ kind: "unsupported-image" } as const, { error: "unsupported-image" }],
  ])(
    "asks for the photo again when Auction refuses it with %o",
    async (refusal, expected) => {
      const { dispatcher } = fakeLots({ edit: refusal });

      await expect(
        dispatcher.execute({
          identity: admin,
          intent: "set-lot-image",
          lotId,
          image: new Uint8Array([1]),
        }),
      ).resolves.toEqual({
        kind: "lot-ask",
        question: { kind: "image", lotId },
        lot: expect.objectContaining({ lotId, hasImage: false }),
        ...expected,
      });
    },
  );

  it("asks the title again when its edit is refused as empty", async () => {
    const { dispatcher } = fakeLots({ edit: { kind: "empty-title" } });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-text",
        lotId,
        field: "title",
        value: " ",
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "text", field: "title", lotId },
      error: "empty-title",
    });
  });

  it("asks the description again when the answer is blank and leaves the stored one", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-text",
        lotId,
        field: "description",
        value: " \n ",
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "text", field: "description", lotId },
      lot: { description: "Синяя." },
      error: "empty-description",
    });
    expect(methods()).toEqual(["getLot"]);
  });

  it("does not edit the text of a lot without a catalog card", async () => {
    const { card: _card, ...bare } = drafted;
    const { dispatcher, methods } = fakeLots({
      read: { kind: "ok", lot: bare },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-text",
        lotId,
        field: "description",
        value: "Синяя.",
      }),
    ).resolves.toMatchObject({ kind: "lot-refused", reason: "lot-not-found" });
    expect(methods()).toEqual(["getLot"]);
  });

  it("checks the price before the step is asked and sends nothing to Auction yet", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "check-lot-price",
        lotId,
        value: "1 500",
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "step", lotId, priceRubles: 1500 },
    });
    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "check-lot-price",
        lotId,
        value: "дорого",
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "price", lotId },
      error: "amount-format",
    });
    expect(methods()).toEqual(["getLot", "getLot"]);
  });

  it("sends the price and the step to Auction as one command in kopecks, with the auction of the lot", async () => {
    const { dispatcher, calls } = fakeLots();

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-terms",
      lotId,
      priceRubles: 1500,
      value: "100",
      opId,
    });

    expect(calls.at(-1)).toEqual({
      method: "scheduleLot",
      args: {
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 150_000, currency: "RUB" },
        step: { minorUnits: 10_000, currency: "RUB" },
      },
    });
    expect(result).toMatchObject({
      kind: "lot-form",
      lot: {
        terms: {
          kind: "set",
          startingPrice: { minorUnits: 150_000, currency: "RUB" },
          step: { minorUnits: 10_000, currency: "RUB" },
        },
      },
      saved: "terms",
    });
  });

  it("asks the step again with the same price when it is not a number and sends no command", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1500,
        value: "0",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "step", lotId, priceRubles: 1500 },
      error: "amount-range",
    });
    expect(methods()).toEqual(["getLot"]);
  });

  it.each([
    [{ kind: "lots-frozen" } as const, "terms-closed"],
    [{ kind: "scheduling-closed" } as const, "terms-closed"],
    [{ kind: "lot-not-in-auction" } as const, "lot-not-in-auction"],
    [{ kind: "not-administrator" } as const, "not-administrator"],
  ])("answers the refusal %j of the terms as %s", async (schedule, reason) => {
    const { dispatcher } = fakeLots({ schedule });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1500,
        value: "100",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-refused", reason });
  });

  it("treats an auction in another currency as a defect of the neighbour, not as an answer to show", async () => {
    const { dispatcher } = fakeLots({
      schedule: { kind: "currency-mismatch" },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1500,
        value: "100",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "dependency-rejected",
      reason: "invalid",
    });
  });

  it("answers every lot form request with a rejection when Auction is not configured", async () => {
    await expect(
      createDispatcher().execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "auction-not-configured" });
  });
});
