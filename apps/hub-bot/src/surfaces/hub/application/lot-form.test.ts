import { afterEach, describe, expect, it, vi } from "vitest";
import type { LotView } from "../../../auction-ui/index.js";
import type {
  AddLotResult,
  LotAdministration,
  LotCardResult,
  LotReadResult,
  ScheduleLotResult,
} from "../auction/port.js";
import { createDispatcher } from "./dispatcher.js";
import { fingerprint } from "./fingerprint.js";
import {
  baseTitle,
  lotCopyId,
  lotCopySetId,
  lotReadWindowMs,
  numberedTitle,
  parseLotCopies,
  parseRubles,
} from "./lot-form.js";
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
  rights: ["access-hub", "place-bids"] as const,
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
    // Ответы первых чтений по порядку; дальше — `read`.
    reads?: LotReadResult[];
  } = {},
) {
  const reads = [...(answers.reads ?? [])];
  const calls: { method: keyof LotAdministration; args: unknown }[] = [];
  // Бюджет каждого чтения: повторное чтение формы его сужает.
  const readDeadlines: (number | undefined)[] = [];
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
    async getLot(_person, id, meta) {
      calls.push({ method: "getLot", args: id });
      readDeadlines.push(meta?.deadlineAt);
      return reads.shift() ?? answers.read ?? { kind: "ok", lot: drafted };
    },
    async removeLot(_person, lot) {
      calls.push({ method: "removeLot", args: lot });
      return { kind: "ok" };
    },
    async getLotImage(_person, id) {
      calls.push({ method: "getLotImage", args: id });
      return { kind: "not-found" };
    },
  };
  const dispatcher = createDispatcher(
    undefined,
    undefined,
    undefined,
    undefined,
    port,
  );
  return {
    dispatcher,
    calls,
    readDeadlines,
    methods: () => calls.map((call) => call.method),
  };
}

describe("lot copies of the lot form", () => {
  it.each([
    ["2", 2],
    [" 7 ", 7],
    ["20", 20],
  ])("reads %j as %d lots in all", (raw, count) => {
    expect(parseLotCopies(raw)).toBe(count);
  });

  it.each(["0", "1", "21", "007", "семь", "7.5", ""])(
    "refuses %j as a count of lots",
    (raw) => {
      expect(parseLotCopies(raw)).toBeUndefined();
    },
  );

  it("numbers a title by its place in the set and strips a number the title already has", () => {
    expect(numberedTitle("Ваза", 3, 7)).toBe("Ваза | 3 из 7");
    expect(baseTitle("Ваза | 3 из 7")).toBe("Ваза");
    expect(baseTitle("Ваза|3 из 7 ")).toBe("Ваза");
    expect(baseTitle("Ваза | синяя")).toBe("Ваза | синяя");
  });

  it("derives the same canonical UUIDv7 for a copy and the set of one lot, ordered after it", () => {
    const v7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const copies = [2, 3, 4].map((position) => lotCopyId(lotId, position));
    expect(copies.map((copy) => lotCopyId(lotId, 2) === copy)).toEqual([
      true,
      false,
      false,
    ]);
    for (const id of [...copies, lotCopySetId(lotId)]) expect(id).toMatch(v7);
    expect([lotId, ...copies]).toEqual([lotId, ...copies].toSorted());
    expect(lotCopySetId(lotId)).toBe(lotCopySetId(lotId));
  });
});

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

  describe("lot form reading a lot the read model of Auction does not know yet", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reads a just created lot again until Auction knows it", async () => {
      vi.useFakeTimers();
      const { dispatcher, methods } = fakeLots({
        reads: [{ kind: "not-found" }, { kind: "not-found" }],
      });

      const result = dispatcher.execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
      });
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);

      await expect(result).resolves.toMatchObject({
        kind: "lot-form",
        lot: { lotId, title: "Ваза" },
      });
      expect(methods()).toEqual(["getLot", "getLot", "getLot"]);
    });

    it("saves the photo of a lot the first read did not find yet", async () => {
      vi.useFakeTimers();
      const { dispatcher, calls } = fakeLots({
        reads: [{ kind: "not-found" }],
      });

      const result = dispatcher.execute({
        identity: admin,
        intent: "set-lot-image",
        lotId,
        image: new Uint8Array([1, 2, 3]),
      });
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);

      await expect(result).resolves.toMatchObject({
        kind: "lot-form",
        saved: "image",
      });
      expect(calls.map((call) => call.method)).toEqual([
        "getLot",
        "getLot",
        "editLotCard",
      ]);
    });

    it("answers a lot Auction does not know with a refusal once the window is over", async () => {
      vi.useFakeTimers();
      const { dispatcher, methods } = fakeLots({ read: { kind: "not-found" } });
      const startedAt = Date.now();

      const result = dispatcher.execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
      });
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);

      await expect(result).resolves.toEqual({
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId,
      });
      expect(Date.now() - startedAt).toBeLessThanOrEqual(lotReadWindowMs);
      expect(methods().length).toBeGreaterThan(1);
    });

    it("keeps the last second of the action budget for the command after the read", async () => {
      vi.useFakeTimers();
      const { dispatcher, methods, readDeadlines } = fakeLots({
        read: { kind: "not-found" },
      });
      const deadlineAt = Date.now() + 2_000;

      const result = dispatcher.execute({
        identity: admin,
        intent: "set-lot-image",
        lotId,
        image: new Uint8Array([1, 2, 3]),
        deadlineAt,
      });
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);

      await expect(result).resolves.toMatchObject({
        reason: "lot-not-found",
      });
      // Повторы идут, пока до запаса команды остаётся шаг и чтение, и каждое
      // повторное чтение само не заходит в запас.
      expect(methods()).toEqual(["getLot", "getLot", "getLot", "getLot"]);
      expect(readDeadlines).toEqual([
        deadlineAt,
        deadlineAt - 1_000,
        deadlineAt - 1_000,
        deadlineAt - 1_000,
      ]);
    });

    it("reads a lot to show the form up to the action budget, with no command to leave time for", async () => {
      vi.useFakeTimers();
      const { dispatcher, methods, readDeadlines } = fakeLots({
        read: { kind: "not-found" },
      });
      const deadlineAt = Date.now() + 1_300;

      const result = dispatcher.execute({
        identity: admin,
        intent: "view-lot-form",
        lotId,
        deadlineAt,
      });
      await vi.advanceTimersByTimeAsync(lotReadWindowMs);

      await expect(result).resolves.toMatchObject({
        reason: "lot-not-found",
      });
      expect(methods()).toHaveLength(5);
      expect(new Set(readDeadlines)).toEqual(new Set([deadlineAt]));
    });

    it("does not read again a lot Auction refused for another reason", async () => {
      const { dispatcher, methods } = fakeLots({
        read: { kind: "unavailable", cause: new Error("down") },
      });

      await expect(
        dispatcher.execute({ identity: admin, intent: "view-lot-form", lotId }),
      ).resolves.toMatchObject({ kind: "dependency-rejected" });
      expect(methods()).toEqual(["getLot"]);
    });
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

  it("removes the image of the card and resends both texts as they are stored", async () => {
    const { dispatcher, calls } = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          card: {
            title: "Ваза",
            description: "Синяя.",
            image: { version: "img-1" },
          },
        },
      },
    });

    const result = await dispatcher.execute({
      identity: admin,
      intent: "remove-lot-image",
      lotId,
      imagePrint: fingerprint("img-1"),
    });

    expect(calls.at(-1)).toEqual({
      method: "editLotCard",
      args: { lotId, title: "Ваза", description: "Синяя.", removeImage: true },
    });
    expect(result).toMatchObject({
      kind: "lot-form",
      lot: { hasImage: false },
      saved: "image-removed",
    });
  });

  it("removes nothing when the photo changed after the confirmation and asks about the photo again", async () => {
    const { dispatcher, methods } = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          card: {
            title: "Ваза",
            description: "Синяя.",
            image: { version: "img-2" },
          },
        },
      },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "remove-lot-image",
        lotId,
        imagePrint: fingerprint("img-1"),
      }),
    ).resolves.toMatchObject({
      kind: "lot-ask",
      question: { kind: "image", lotId },
      error: "photo-changed",
    });
    expect(methods()).toEqual(["getLot"]);
  });

  it("sends no command when the photo is already gone and answers it as removed", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "remove-lot-image",
        lotId,
        imagePrint: fingerprint("img-1"),
      }),
    ).resolves.toMatchObject({
      kind: "lot-form",
      lot: { hasImage: false },
      saved: "image-removed",
    });
    expect(methods()).toEqual(["getLot"]);
  });

  it("refuses to remove the image of a sold lot before Auction", async () => {
    const { dispatcher, methods } = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          card: {
            title: "Ваза",
            description: "Синяя.",
            image: { version: "img-1" },
          },
          status: {
            kind: "sold",
            winnerId: admin.identityId,
            price: { minorUnits: 90_000, currency: "RUB" },
          },
        },
      },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "remove-lot-image",
        lotId,
        imagePrint: fingerprint("img-1"),
      }),
    ).resolves.toMatchObject({ kind: "lot-refused", reason: "lot-sold" });
    expect(methods()).toEqual(["getLot"]);
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
      kind: "lot-step-mode",
      priceRubles: 1500,
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
      mode: "single",
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
        stepPolicy: {
          kind: "fixed",
          step: { minorUnits: 10_000, currency: "RUB" },
        },
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

  it("sends thresholds to Auction as a tiered policy and shows them on the lot", async () => {
    const { dispatcher, calls } = fakeLots();
    const tiers = [
      {
        lowerBound: { minorUnits: 0, currency: "RUB" },
        step: { minorUnits: 10_000, currency: "RUB" },
      },
      {
        lowerBound: { minorUnits: 500_000, currency: "RUB" },
        step: { minorUnits: 25_000, currency: "RUB" },
      },
      {
        lowerBound: { minorUnits: 2_000_000, currency: "RUB" },
        step: { minorUnits: 50_000, currency: "RUB" },
      },
    ];

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-terms",
      lotId,
      priceRubles: 1000,
      mode: "tiered",
      value: "0 — 100\n5000 — 250\n20000 — 500",
      opId,
    });

    expect(calls.at(-1)).toEqual({
      method: "scheduleLot",
      args: {
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 100_000, currency: "RUB" },
        stepPolicy: { kind: "tiered", tiers },
      },
    });
    expect(result).toMatchObject({
      kind: "lot-form",
      lot: {
        terms: {
          kind: "set",
          startingPrice: { minorUnits: 100_000, currency: "RUB" },
          tiers,
        },
      },
      saved: "terms",
    });
  });

  it("refuses thresholds that start at the starting price and suggests the same lines from zero", async () => {
    const { dispatcher, methods } = fakeLots();

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-terms",
      lotId,
      priceRubles: 1500,
      mode: "tiered",
      value: "1500 — 100\n3000 — 200",
      opId,
    });

    expect(result).toMatchObject({
      kind: "lot-ask",
      question: { kind: "step", lotId, priceRubles: 1500, mode: "tiered" },
      error: "step-start",
      suggestedTiers: [
        {
          lowerBound: { minorUnits: 0, currency: "RUB" },
          step: { minorUnits: 10_000, currency: "RUB" },
        },
        {
          lowerBound: { minorUnits: 300_000, currency: "RUB" },
          step: { minorUnits: 20_000, currency: "RUB" },
        },
      ],
    });
    expect(methods()).toEqual(["getLot"]);
  });

  // Порядок сверяется по присланным строкам, а не по исправленным: замена
  // первой границы нулём не должна прятать нарушение порядка или шага.
  it.each([
    ["a zero line below the first one", "100 — 10\n0 — 20"],
    ["descending bounds", "5000 — 100\n3000 — 200"],
    ["a repeated bound", "1500 — 100\n1500 — 200"],
    ["a decreasing step", "1500 — 200\n3000 — 100"],
  ])("suggests no corrected thresholds for lines with %s", async (_, value) => {
    const { dispatcher } = fakeLots();

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-terms",
      lotId,
      priceRubles: 1000,
      mode: "tiered",
      value,
      opId,
    });

    expect(result).toMatchObject({ kind: "lot-ask", error: "step-start" });
    expect(result).not.toHaveProperty("suggestedTiers");
  });

  it("suggests no corrected thresholds when there are too many to repeat", async () => {
    const { dispatcher } = fakeLots();
    const value = Array.from(
      { length: 21 },
      (_, i) => `${(i + 1) * 100} — 10`,
    ).join("\n");

    const result = await dispatcher.execute({
      identity: admin,
      intent: "set-lot-terms",
      lotId,
      priceRubles: 1000,
      mode: "tiered",
      value,
      opId,
    });

    expect(result).toMatchObject({ kind: "lot-ask", error: "step-start" });
    expect(result).not.toHaveProperty("suggestedTiers");
  });

  it("refuses thresholds whose step decreases", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1000,
        mode: "tiered",
        value: "0 — 500\n5000 — 100",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-ask", error: "step-decreasing" });
    expect(methods()).toEqual(["getLot"]);
  });

  // Равный шаг на следующем пороге не убывает.
  it.each([
    ["grows", "0 — 100\n5000 — 250"],
    ["stays the same", "0 — 100\n5000 — 100"],
  ])("accepts thresholds whose step %s", async (_, value) => {
    const { dispatcher } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1000,
        mode: "tiered",
        value,
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-form", saved: "terms" });
  });

  it("refuses thresholds that do not ascend", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1000,
        mode: "tiered",
        value: "0 — 10\n5000 — 20\n3000 — 30",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-ask", error: "step-order" });
    expect(methods()).toEqual(["getLot"]);
  });

  it("refuses a threshold line without a dash separator", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1000,
        mode: "tiered",
        value: "0 100",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-ask", error: "step-format" });
    expect(methods()).toEqual(["getLot"]);
  });

  it("asks the step again with the same price when it is not a number and sends no command", async () => {
    const { dispatcher, methods } = fakeLots();

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "set-lot-terms",
        lotId,
        priceRubles: 1500,
        mode: "single",
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

  // Черновой лот и пороги без строк: Auction пустые пороги не примет, и
  // оставлять нечего.
  it.each([
    ["a draft lot", drafted],
    [
      "empty thresholds",
      {
        ...drafted,
        tiers: [],
        status: {
          kind: "scheduled",
          startingPrice: { minorUnits: 150_000, currency: "RUB" },
        },
      } satisfies LotView,
    ],
  ])(
    "asks the step mode again for %s with no step to keep and sends no command",
    async (_, lot) => {
      const { dispatcher, methods } = fakeLots({ read: { kind: "ok", lot } });

      await expect(
        dispatcher.execute({
          identity: admin,
          intent: "keep-lot-step",
          lotId,
          priceRubles: 2500,
          opId,
        }),
      ).resolves.toMatchObject({ kind: "lot-step-mode", priceRubles: 2500 });
      expect(methods()).toEqual(["getLot"]);
    },
  );

  it("refuses to keep the step once the trading of the lot has begun", async () => {
    const { dispatcher, methods } = fakeLots({
      read: {
        kind: "ok",
        lot: {
          ...drafted,
          fixedStep: { minorUnits: 10_000, currency: "RUB" },
          status: {
            kind: "trading",
            currentPrice: { minorUnits: 150_000, currency: "RUB" },
            phase: "online",
          },
        },
      },
    });

    await expect(
      dispatcher.execute({
        identity: admin,
        intent: "keep-lot-step",
        lotId,
        priceRubles: 2500,
        opId,
      }),
    ).resolves.toMatchObject({ kind: "lot-refused", reason: "terms-closed" });
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
        mode: "single",
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
        mode: "single",
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
