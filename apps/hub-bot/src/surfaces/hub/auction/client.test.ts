import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionState_DraftSchema,
  AuctionState_PrebiddingSchema,
  AuctionState_ScheduledSchema,
} from "../../../../gen/auction/v1/auction_events_pb.js";
import { BidSource } from "../../../../gen/auction/v1/auction_pb.js";
import {
  AddLotResponseSchema,
  AdvanceAskResponseSchema,
  AuctionSnapshotSchema,
  CloseLotResponseSchema,
  CreateLotCardResponseSchema,
  DiscardAuctionResponseSchema,
  DraftAuctionResponseSchema,
  EditLotCardResponseSchema,
  FreezeFinalLineupRefusalSchema,
  FreezeFinalLineupResponseSchema,
  GetAuctionConsoleResponseSchema,
  GetAuctionLotStatisticsResponseSchema,
  GetMeetupAuctionResponseSchema,
  GetRaffleResponseSchema,
  ListAuctionsResponseSchema,
  ListLotHistoryResponseSchema,
  LotSnapshotSchema,
  RaffleSchema,
  RaffleStatus,
  ScheduleAuctionResponseSchema,
  ScheduleLotResponseSchema,
  SelectForFinalResponseSchema,
  StartFinalResponseSchema,
  StartNextLotResponseSchema,
  StartPrebiddingResponseSchema,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import { AccessRight } from "../../../../gen/identity/v1/access_pb.js";
import { createAuctionAdapter, createLotTitleReader } from "./client.js";

// Перевод ответов Auction для оболочки сходки (PER-307). Транспорт и токен
// вызывающего проверяет `service-token.test.ts`; здесь — смысл ответа.

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const opId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
// В Auction едут только права администратора: каталог лотов открывает
// `manage_meetups` (ADR-065).
const admin = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids", "manage-meetups"] as const,
};
const wireAdmin = {
  identityId: admin.identityId,
  rights: [
    AccessRight.ACCESS_HUB,
    AccessRight.PLACE_BIDS,
    AccessRight.MANAGE_MEETUPS,
  ],
};

const notUsed = () => Promise.reject(new Error("not used"));

type Call = (request: unknown) => Promise<unknown>;

function adapter(rpc: {
  draftAuction?: Call;
  getMeetupAuction?: Call;
  createLotCard?: Call;
  editLotCard?: Call;
  addLot?: Call;
  scheduleLot?: Call;
  getLot?: Call;
  getAuctionConsole?: Call;
  getAuctionLotStatistics?: Call;
  scheduleAuction?: Call;
  startPrebidding?: Call;
  discardAuction?: Call;
  selectForFinal?: Call;
  deselectForFinal?: Call;
  freezeFinalLineup?: Call;
  startFinal?: Call;
  startNextLot?: Call;
  advanceAsk?: Call;
  closeLot?: Call;
  listLotHistory?: Call;
  getDisplayNames?: Call;
  listAuctions?: Call;
  getRaffle?: Call;
}) {
  return createAuctionAdapter({
    draftAuction: (rpc.draftAuction ?? notUsed) as never,
    getMeetupAuction: (rpc.getMeetupAuction ?? notUsed) as never,
    listAuctions: (rpc.listAuctions ?? notUsed) as never,
    createLotCard: (rpc.createLotCard ?? notUsed) as never,
    editLotCard: (rpc.editLotCard ?? notUsed) as never,
    addLot: (rpc.addLot ?? notUsed) as never,
    scheduleLot: (rpc.scheduleLot ?? notUsed) as never,
    getLot: (rpc.getLot ?? notUsed) as never,
    listAuctionLots: notUsed,
    listLotHistory: (rpc.listLotHistory ?? notUsed) as never,
    getDisplayNames: (rpc.getDisplayNames ?? notUsed) as never,
    placeBid: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getAuction: notUsed,
    getRaffle: (rpc.getRaffle ?? notUsed) as never,
    registerForRaffle: notUsed,
    cancelRaffleRegistration: notUsed,
    getLotImage: notUsed,
    getAuctionConsole: (rpc.getAuctionConsole ?? notUsed) as never,
    getAuctionLotStatistics: (rpc.getAuctionLotStatistics ?? notUsed) as never,
    scheduleAuction: (rpc.scheduleAuction ?? notUsed) as never,
    startPrebidding: (rpc.startPrebidding ?? notUsed) as never,
    discardAuction: (rpc.discardAuction ?? notUsed) as never,
    selectForFinal: (rpc.selectForFinal ?? notUsed) as never,
    deselectForFinal: (rpc.deselectForFinal ?? notUsed) as never,
    freezeFinalLineup: (rpc.freezeFinalLineup ?? notUsed) as never,
    startFinal: (rpc.startFinal ?? notUsed) as never,
    startNextLot: (rpc.startNextLot ?? notUsed) as never,
    advanceAsk: (rpc.advanceAsk ?? notUsed) as never,
    closeLot: (rpc.closeLot ?? notUsed) as never,
  });
}

describe("auction adapter", () => {
  it("reads the auction of the meetup and its absence as an answer", async () => {
    const found = adapter({
      getMeetupAuction: async () =>
        create(GetMeetupAuctionResponseSchema, {
          auction: create(AuctionSnapshotSchema, {
            id: auctionId,
            status: {
              case: "draft",
              value: create(AuctionState_DraftSchema, {}),
            },
          }),
        }),
    });
    const absent = adapter({
      getMeetupAuction: async () => create(GetMeetupAuctionResponseSchema, {}),
    });

    // Стадия нужна строке аукциона на карточке сходки (PER-594).
    await expect(found.getMeetupAuction(admin, meetupId)).resolves.toEqual({
      kind: "ok",
      auctionId,
      auction: { auctionId, stage: "draft", final: false },
    });
    await expect(absent.getMeetupAuction(admin, meetupId)).resolves.toEqual({
      kind: "ok",
    });
  });

  // Снимок без статуса — дефект соседа: строки на карточке не будет, но меню
  // «Расширения» по-прежнему открывает аукцион по идентификатору (PER-594).
  it("keeps the auction of the meetup when its snapshot has no status", async () => {
    const broken = adapter({
      getMeetupAuction: async () =>
        create(GetMeetupAuctionResponseSchema, {
          auction: create(AuctionSnapshotSchema, { id: auctionId }),
        }),
    });

    await expect(broken.getMeetupAuction(admin, meetupId)).resolves.toEqual({
      kind: "ok",
      auctionId,
    });
  });

  it("sends the meetup, the key of the press and the rights of the viewer without roles", async () => {
    const draftAuction = vi.fn(async () =>
      create(DraftAuctionResponseSchema, {
        outcome: {
          case: "accepted",
          value: { auctionId, alreadyExisted: true },
        },
      }),
    );

    await expect(
      adapter({ draftAuction }).enableAuction(admin, meetupId, opId),
    ).resolves.toEqual({ kind: "enabled", auctionId, alreadyExisted: true });
    expect(draftAuction).toHaveBeenCalledWith(
      expect.objectContaining({
        meetupId,
        opId,
        viewer: wireAdmin,
      }),
      expect.anything(),
    );
  });

  it.each([
    ["notMeetupAdministrator", { kind: "not-administrator" }],
    ["meetupNotFound", { kind: "meetup-not-found" }],
  ] as const)(
    "reads the %s refusal as a final answer",
    async (reason, expected) => {
      const enabled = adapter({
        draftAuction: async () =>
          create(DraftAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
      });

      await expect(
        enabled.enableAuction(admin, meetupId, opId),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    [Code.DeadlineExceeded, "timeout"],
    [Code.PermissionDenied, "forbidden"],
    [Code.InvalidArgument, "invalid"],
    [Code.Unavailable, "unavailable"],
  ] as const)("maps status %s to %s", async (code, kind) => {
    const failing = adapter({
      draftAuction: () => Promise.reject(new ConnectError("no", code)),
    });

    await expect(
      failing.enableAuction(admin, meetupId, opId),
    ).resolves.toMatchObject({ kind });
  });
});

// Форма лота (PER-319): команды каталога, реестра и условий торгов.
describe("auction adapter of the lot form", () => {
  const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
  const card = { lotId, title: "Ваза", description: "" };
  const refused = (schema: Parameters<typeof create>[0], reason: string) =>
    create(schema, {
      outcome: {
        case: "refused",
        value: { reason: { case: reason, value: {} } },
      },
    } as never);

  it("sends the text of a card and never an image", async () => {
    const createLotCard = vi.fn(async () =>
      create(CreateLotCardResponseSchema, {
        outcome: { case: "accepted", value: { title: "Ваза" } },
      }),
    );
    const editLotCard = vi.fn(async () =>
      create(EditLotCardResponseSchema, {
        outcome: { case: "accepted", value: { title: "Ваза" } },
      }),
    );
    const lots = adapter({ createLotCard, editLotCard });

    await expect(lots.createLotCard(admin, card)).resolves.toEqual({
      kind: "ok",
    });
    await expect(lots.editLotCard(admin, card)).resolves.toEqual({
      kind: "ok",
    });
    const sent = {
      ...card,
      viewer: wireAdmin,
    };
    expect(createLotCard).toHaveBeenCalledWith(sent, expect.anything());
    expect(editLotCard).toHaveBeenCalledWith(sent, expect.anything());
  });

  it.each([
    ["notAdmin", { kind: "not-admin" }],
    ["emptyTitle", { kind: "empty-title" }],
    ["cardConflict", { kind: "card-conflict" }],
  ] as const)(
    "reads the %s refusal of a new card as a final answer",
    async (reason, expected) => {
      const lots = adapter({
        createLotCard: async () => refused(CreateLotCardResponseSchema, reason),
      });

      await expect(lots.createLotCard(admin, card)).resolves.toEqual(expected);
    },
  );

  it("reads CardNotFound of an edit as a final answer and an image refusal of a text edit as a defect", async () => {
    const missing = adapter({
      editLotCard: async () =>
        refused(EditLotCardResponseSchema, "cardNotFound"),
    });
    const image = adapter({
      editLotCard: async () =>
        refused(EditLotCardResponseSchema, "unsupportedImage"),
    });

    await expect(missing.editLotCard(admin, card)).resolves.toEqual({
      kind: "card-not-found",
    });
    await expect(image.editLotCard(admin, card)).resolves.toMatchObject({
      kind: "invalid",
    });
  });

  it("sends a new image as a replacement and reads its refusals as final answers", async () => {
    const content = new Uint8Array([0xff, 0xd8, 0xff]);
    const editLotCard = vi.fn(async () =>
      create(EditLotCardResponseSchema, {
        outcome: {
          case: "refused",
          value: {
            reason: { case: "imageTooLarge", value: { maxBytes: 2_097_152n } },
          },
        },
      }),
    );
    const unsupported = adapter({
      editLotCard: async () =>
        refused(EditLotCardResponseSchema, "unsupportedImage"),
    });

    await expect(
      adapter({ editLotCard }).editLotCard(admin, { ...card, image: content }),
    ).resolves.toEqual({ kind: "image-too-large", maxBytes: 2_097_152 });
    await expect(
      unsupported.editLotCard(admin, { ...card, image: content }),
    ).resolves.toEqual({ kind: "unsupported-image" });
    expect(editLotCard).toHaveBeenCalledWith(
      {
        ...card,
        viewer: wireAdmin,
        imageChange: { case: "replaceImage", value: { content } },
      },
      expect.anything(),
    );
  });

  it.each([
    ["notMeetupAdministrator", { kind: "not-administrator" }],
    ["meetupNotFound", { kind: "meetup-not-found" }],
    ["lotsFrozen", { kind: "lots-frozen" }],
  ] as const)(
    "reads the %s refusal of an addition as a final answer",
    async (reason, expected) => {
      const lots = adapter({
        addLot: async () => refused(AddLotResponseSchema, reason),
      });

      await expect(
        lots.addLot(admin, { auctionId, lotId, opId }),
      ).resolves.toEqual(expected);
    },
  );

  it("sends the price and one fixed step in minor units", async () => {
    const scheduleLot = vi.fn(async () =>
      create(ScheduleLotResponseSchema, {
        outcome: { case: "accepted", value: {} },
      }),
    );

    await expect(
      adapter({ scheduleLot }).scheduleLot(admin, {
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 150_000, currency: "RUB" },
        stepPolicy: {
          kind: "fixed",
          step: { minorUnits: 10_000, currency: "RUB" },
        },
      }),
    ).resolves.toEqual({ kind: "ok" });
    expect(scheduleLot).toHaveBeenCalledWith(
      {
        viewer: wireAdmin,
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 150_000n, currency: "RUB" },
        stepPolicy: {
          policy: {
            case: "fixed",
            value: { minorUnits: 10_000n, currency: "RUB" },
          },
        },
      },
      expect.anything(),
    );
  });

  it.each([
    ["notMeetupAdministrator", "not-administrator"],
    ["meetupNotFound", "meetup-not-found"],
    ["lotsFrozen", "lots-frozen"],
    ["lotNotInAuction", "lot-not-in-auction"],
    ["schedulingClosed", "scheduling-closed"],
    ["stepPolicyInvalid", "step-policy-invalid"],
    ["currencyMismatch", "currency-mismatch"],
  ] as const)(
    "reads the %s refusal of the terms as a final answer",
    async (reason, kind) => {
      const lots = adapter({
        scheduleLot: async () => refused(ScheduleLotResponseSchema, reason),
      });

      await expect(
        lots.scheduleLot(admin, {
          auctionId,
          lotId,
          opId,
          startingPrice: { minorUnits: 100, currency: "RUB" },
          stepPolicy: {
            kind: "fixed",
            step: { minorUnits: 100, currency: "RUB" },
          },
        }),
      ).resolves.toEqual({ kind });
    },
  );

  it("reads a response without an outcome as a defect of the neighbour", async () => {
    const lots = adapter({
      addLot: async () => create(AddLotResponseSchema, {}),
      scheduleLot: async () => create(ScheduleLotResponseSchema, {}),
    });

    await expect(
      lots.addLot(admin, { auctionId, lotId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      lots.scheduleLot(admin, {
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 100, currency: "RUB" },
        stepPolicy: {
          kind: "fixed",
          step: { minorUnits: 100, currency: "RUB" },
        },
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("tells an auction without a journal and a taken op_id from a failure worth a retry", async () => {
    const missing = adapter({
      addLot: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    const taken = adapter({
      scheduleLot: () =>
        Promise.reject(new ConnectError("no", Code.AlreadyExists)),
    });

    await expect(
      missing.addLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
    await expect(
      taken.scheduleLot(admin, {
        auctionId,
        lotId,
        opId,
        startingPrice: { minorUnits: 100, currency: "RUB" },
        stepPolicy: {
          kind: "fixed",
          step: { minorUnits: 100, currency: "RUB" },
        },
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("reads a lot for the form and a lot Auction does not show as not found", async () => {
    const found = adapter({
      getLot: async () =>
        create(LotSnapshotSchema, {
          id: lotId,
          auctionId,
          version: 1n,
          card: { title: "Ваза", description: "" },
          status: { case: "draft", value: {} },
        }),
    });
    const hidden = adapter({
      getLot: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });

    await expect(found.getLot(admin, lotId)).resolves.toEqual({
      kind: "ok",
      lot: {
        lotId,
        auctionId,
        version: 1,
        card: { title: "Ваза", description: "" },
        proxyEnabled: false,
        status: { kind: "draft" },
      },
    });
    await expect(hidden.getLot(admin, lotId)).resolves.toEqual({
      kind: "not-found",
    });
  });
});

// Пульт аукциона (PER-320): что уходит в Auction и как читается ответ.
describe("auction console adapter", () => {
  const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
  const week = {
    auctionId,
    opId,
    opensAt: "2026-10-20T15:00:00Z",
    closesAt: "2026-10-26T21:00:00Z",
    windows: [],
    raffleClosesAt: undefined,
  };

  it.each([
    [
      true,
      1,
      {
        case: "mixed",
        value: expect.objectContaining({ onlineByDeadline: true }),
      },
    ],
    [false, 0, { case: "byDeadline", value: expect.anything() }],
  ] as const)(
    "schedules the week with the final %s, closing the lots by the deadline and without lot defaults",
    async (final, finalBlocks, policy) => {
      const scheduleAuction = vi.fn(async (_request: unknown) =>
        create(ScheduleAuctionResponseSchema, {
          outcome: { case: "accepted", value: {} },
        }),
      );

      await expect(
        adapter({ scheduleAuction }).scheduleAuction(admin, {
          ...week,
          final,
        }),
      ).resolves.toEqual({ kind: "ok" });
      const sent = scheduleAuction.mock.calls[0]?.[0] as {
        config: Record<string, unknown>;
      };
      expect(sent).toMatchObject({ auctionId, opId });
      expect(sent.config).toEqual({
        onlinePhase: {
          opensAt: week.opensAt,
          closesAt: week.closesAt,
          closesLots: true,
        },
        finalBlocks,
        closingPolicy: { policy },
        stepWindows: [],
      });
      expect(sent.config).not.toHaveProperty("lotDefaults");
    },
  );

  it("reads only the order of the week as a refusal of the person and the rest as a defect", async () => {
    const refusing = (reason: string) =>
      adapter({
        scheduleAuction: async () =>
          create(ScheduleAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: {
                reason: {
                  case: "configInvalid",
                  value: { reason: { case: reason as never, value: {} } },
                },
              },
            },
          }),
      });

    await expect(
      refusing("closesAtNotAfterOpensAt").scheduleAuction(admin, {
        ...week,
        final: true,
      }),
    ).resolves.toEqual({ kind: "closes-not-after-opens" });
    await expect(
      refusing("finalBlocksOutOfRange").scheduleAuction(admin, {
        ...week,
        final: true,
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      refusing("stepWindowWithoutClosesAt").scheduleAuction(admin, {
        ...week,
        final: true,
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("sends the happy hours windows with the week and reads their refusals by window", async () => {
    const window = {
      from: "2026-10-21T15:00:00Z",
      until: "2026-10-21T18:00:00Z",
      step: { minorUnits: 5_000, currency: "RUB" },
      lotIds: [lotId],
    };
    const scheduleAuction = vi.fn(async (_request: unknown) =>
      create(ScheduleAuctionResponseSchema, {
        outcome: { case: "accepted", value: {} },
      }),
    );
    await adapter({ scheduleAuction }).scheduleAuction(admin, {
      ...week,
      final: true,
      windows: [window],
    });
    const sent = scheduleAuction.mock.calls[0]?.[0] as {
      config: { stepWindows: unknown };
    };
    expect(sent.config.stepWindows).toEqual([
      { ...window, step: { minorUnits: 5_000n, currency: "RUB" } },
    ]);

    const refusing = (reason: { case: string; value: object }) =>
      adapter({
        scheduleAuction: async () =>
          create(ScheduleAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: {
                reason: {
                  case: "configInvalid",
                  value: { reason: reason as never },
                },
              },
            },
          }),
      }).scheduleAuction(admin, { ...week, final: true, windows: [window] });
    await expect(
      refusing({
        case: "stepWindowOutsideOnlinePhase",
        value: { windowIndex: 0 },
      }),
    ).resolves.toEqual({ kind: "window-outside-week", window: 0 });
    await expect(
      refusing({
        case: "stepWindowsOverlap",
        value: { firstIndex: 0, secondIndex: 2 },
      }),
    ).resolves.toEqual({ kind: "windows-overlap", first: 0, second: 2 });
    await expect(
      refusing({ case: "stepWindowStepInvalid", value: { windowIndex: 1 } }),
    ).resolves.toEqual({ kind: "window-step-invalid", window: 1 });
    await expect(
      refusing({ case: "stepWindowLotsEmpty", value: { windowIndex: 1 } }),
    ).resolves.toEqual({ kind: "window-lots-empty", window: 1 });
  });

  // Розыгрыш (PER-593): момент едет в онлайн-фазе, неделя без него — без
  // поля, а оба отказа Auction о моменте — ответ человеку.
  it("sends the raffle moment in the online phase and reads its refusals", async () => {
    const scheduleAuction = vi.fn(async (_request: unknown) =>
      create(ScheduleAuctionResponseSchema, {
        outcome: { case: "accepted", value: {} },
      }),
    );
    const raffleClosesAt = "2026-10-22T15:00:00Z";
    await adapter({ scheduleAuction }).scheduleAuction(admin, {
      ...week,
      final: true,
      raffleClosesAt,
    });
    await adapter({ scheduleAuction }).scheduleAuction(admin, {
      ...week,
      final: true,
    });
    const phases = scheduleAuction.mock.calls.map(
      (call) =>
        (call[0] as { config: { onlinePhase: Record<string, unknown> } }).config
          .onlinePhase,
    );
    expect(phases[0]).toMatchObject({ raffleClosesAt });
    expect(phases[1]).not.toHaveProperty("raffleClosesAt");

    const refusing = (reason: string) =>
      adapter({
        scheduleAuction: async () =>
          create(ScheduleAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: {
                reason: {
                  case: "configInvalid",
                  value: { reason: { case: reason as never, value: {} } },
                },
              },
            },
          }),
      }).scheduleAuction(admin, { ...week, final: true, raffleClosesAt });
    await expect(refusing("raffleClosesAtNotAfterOpensAt")).resolves.toEqual({
      kind: "raffle-not-after-opens",
    });
    await expect(refusing("raffleClosesAtNotBeforeClosesAt")).resolves.toEqual({
      kind: "raffle-not-before-closes",
    });
  });

  it("reads the raffle moment of the console and its absence", async () => {
    const reading = (raffleClosesAt: string | undefined) =>
      adapter({
        getAuctionConsole: async () =>
          create(GetAuctionConsoleResponseSchema, {
            outcome: {
              case: "console",
              value: {
                auction: {
                  id: auctionId,
                  config: {
                    onlinePhase: {
                      opensAt: week.opensAt,
                      closesAt: week.closesAt,
                      closesLots: true,
                      ...(raffleClosesAt === undefined
                        ? {}
                        : { raffleClosesAt }),
                    },
                  },
                  status: { case: "scheduled", value: {} },
                },
                lots: [],
              },
            },
          }),
      }).getAuctionConsole(admin, auctionId);

    await expect(reading("2026-10-22T15:00:00Z")).resolves.toMatchObject({
      kind: "ok",
      console: { week: { raffleClosesAt: "2026-10-22T15:00:00Z" } },
    });
    const without = await reading(undefined);
    expect(without.kind === "ok" && without.console.week).not.toHaveProperty(
      "raffleClosesAt",
    );
  });

  it("reads the happy hours windows of the console and takes a window without a step for a defect", async () => {
    const reading = (step: object | undefined) =>
      adapter({
        getAuctionConsole: async () =>
          create(GetAuctionConsoleResponseSchema, {
            outcome: {
              case: "console",
              value: {
                auction: {
                  id: auctionId,
                  config: {
                    onlinePhase: {
                      opensAt: week.opensAt,
                      closesAt: week.closesAt,
                      closesLots: true,
                    },
                    stepWindows: [
                      {
                        from: "2026-10-21T15:00:00Z",
                        until: "2026-10-21T18:00:00Z",
                        ...(step === undefined ? {} : { step }),
                        lotIds: [lotId],
                      },
                    ],
                  },
                  status: { case: "scheduled", value: {} },
                },
                lots: [],
              },
            },
          }),
      }).getAuctionConsole(admin, auctionId);

    await expect(
      reading({ minorUnits: 5_000n, currency: "RUB" }),
    ).resolves.toMatchObject({
      kind: "ok",
      console: {
        week: {
          windows: [
            {
              from: "2026-10-21T15:00:00Z",
              until: "2026-10-21T18:00:00Z",
              step: { minorUnits: 5_000, currency: "RUB" },
              lotIds: [lotId],
            },
          ],
        },
      },
    });
    // Дефект перевода человек видит как «недоступно», а не пульт с выдумкой.
    await expect(reading(undefined)).resolves.toMatchObject({
      kind: "unavailable",
    });
  });

  it("reads the console: state, week, lots with their bids, the final mark and the overdue flag", async () => {
    const read = adapter({
      getAuctionConsole: async () =>
        create(GetAuctionConsoleResponseSchema, {
          outcome: {
            case: "console",
            value: {
              auction: {
                id: auctionId,
                config: {
                  onlinePhase: {
                    opensAt: week.opensAt,
                    closesAt: week.closesAt,
                    closesLots: true,
                  },
                  finalBlocks: 1,
                },
                status: { case: "prebidding", value: {} },
              },
              lots: [
                {
                  lot: {
                    id: lotId,
                    auctionId,
                    version: 4n,
                    card: { title: "Ваза", description: "" },
                    status: {
                      case: "trading",
                      value: {
                        currentPrice: { minorUnits: 120_000n, currency: "RUB" },
                        phase: 1,
                      },
                    },
                    bidCount: 3n,
                  },
                  markedForFinal: true,
                  overdue: true,
                },
              ],
            },
          },
        }),
    });

    await expect(read.getAuctionConsole(admin, auctionId)).resolves.toEqual({
      kind: "ok",
      console: {
        auctionId,
        status: "prebidding",
        week: {
          opensAt: week.opensAt,
          closesAt: week.closesAt,
          final: true,
          windows: [],
        },
        lots: [
          {
            lot: expect.objectContaining({
              lotId,
              status: {
                kind: "trading",
                currentPrice: { minorUnits: 120_000, currency: "RUB" },
                phase: "online",
              },
            }),
            bidCount: 3,
            markedForFinal: true,
            overdue: true,
          },
        ],
      },
    });
  });

  it("reads ranked-statistics inputs without exposing participant identities", async () => {
    const read = adapter({
      getAuctionLotStatistics: async (request) => {
        expect(request).toMatchObject({
          auctionId,
          viewer: { identityId: admin.identityId },
        });
        return create(GetAuctionLotStatisticsResponseSchema, {
          outcome: {
            case: "statistics",
            value: {
              lots: [
                {
                  lotId,
                  bidCount: 3n,
                  uniqueParticipantCount: 2n,
                  priceGrowth: { minorUnits: 70_000n, currency: "RUB" },
                  lastBidAt: "2026-10-06T09:00:00Z",
                },
              ],
            },
          },
        });
      },
    });

    await expect(
      read.getAuctionLotStatistics(admin, auctionId),
    ).resolves.toEqual({
      kind: "ok",
      lots: [
        {
          lotId,
          bidCount: 3,
          uniqueParticipantCount: 2,
          priceGrowth: { minorUnits: 70_000, currency: "RUB" },
        },
      ],
    });
  });

  it("reads the refusal of a non-administrator and a missing auction", async () => {
    const refused = adapter({
      getAuctionConsole: async () =>
        create(GetAuctionConsoleResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "notMeetupAdministrator", value: {} } },
          },
        }),
    });
    const missing = adapter({
      getAuctionConsole: () =>
        Promise.reject(new ConnectError("no", Code.NotFound)),
    });

    await expect(refused.getAuctionConsole(admin, auctionId)).resolves.toEqual({
      kind: "not-administrator",
    });
    await expect(missing.getAuctionConsole(admin, auctionId)).resolves.toEqual({
      kind: "auction-not-found",
    });
  });

  it("reads a refused start of the week and a passed deadline of a lot as answers", async () => {
    const started = adapter({
      startPrebidding: async () =>
        create(StartPrebiddingResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "auctionNotScheduled", value: {} } },
          },
        }),
      selectForFinal: async () =>
        create(SelectForFinalResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "deadlinePassed", value: {} } },
          },
        }),
    });

    await expect(
      started.startPrebidding(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "not-scheduled" });
    await expect(
      started.selectForFinal(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "refused", reason: "deadline-passed" });
  });

  it("reads a start refused for the trading auction with the id of that auction", async () => {
    const holder = "0190f2a0-0000-7000-8000-000000000021";
    const started = adapter({
      startPrebidding: async () =>
        create(StartPrebiddingResponseSchema, {
          outcome: {
            case: "refused",
            value: {
              reason: {
                case: "anotherAuctionActive",
                value: { auctionId: holder },
              },
            },
          },
        }),
    });

    await expect(
      started.startPrebidding(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "another-auction-active", auctionId: holder });
  });

  // PER-618: пульт читает активные аукционы целиком, страница за страницей,
  // чтобы назвать торги другого аукциона до подтверждения.
  it("reads every page of the active auctions", async () => {
    const holder = "0190f2a0-0000-7000-8000-000000000021";
    const tokens: unknown[] = [];
    const reading = adapter({
      listAuctions: async (request: unknown) => {
        const { pageToken } = request as { pageToken: string };
        tokens.push(pageToken);
        return create(ListAuctionsResponseSchema, {
          auctions: [
            pageToken === ""
              ? create(AuctionSnapshotSchema, {
                  id: auctionId,
                  status: {
                    case: "scheduled",
                    value: create(AuctionState_ScheduledSchema, {}),
                  },
                })
              : create(AuctionSnapshotSchema, {
                  id: holder,
                  status: {
                    case: "prebidding",
                    value: create(AuctionState_PrebiddingSchema, {}),
                  },
                }),
          ],
          nextPageToken: pageToken === "" ? "next" : "",
        });
      },
    });

    await expect(reading.activeAuctions(admin)).resolves.toEqual({
      kind: "ok",
      auctions: [
        { auctionId, stage: "scheduled", final: false },
        { auctionId: holder, stage: "prebidding", final: false },
      ],
    });
    expect(tokens).toEqual(["", "next"]);
  });

  it("reads a refused list of the active auctions as a failure", async () => {
    const reading = adapter({
      listAuctions: () =>
        Promise.reject(new ConnectError("down", Code.Unavailable)),
    });

    await expect(reading.activeAuctions(admin)).resolves.toMatchObject({
      kind: "unavailable",
    });
  });

  it("reads the raffle of the console, its absence and a refusal", async () => {
    const drawn = adapter({
      getRaffle: async () =>
        create(GetRaffleResponseSchema, {
          raffle: create(RaffleSchema, {
            auctionId,
            status: RaffleStatus.DRAWN,
            closesAt: "2026-10-05T16:12:00Z",
            tickets: [{ number: 1, displayName: "Сова*" }],
            reveal: { seed: "cd".repeat(32), winningTicket: 1 },
          }),
        }),
    });
    const absent = adapter({
      getRaffle: async () => create(GetRaffleResponseSchema, {}),
    });
    const refused = adapter({
      getRaffle: () =>
        Promise.reject(new ConnectError("no", Code.PermissionDenied)),
    });

    await expect(drawn.consoleRaffle(admin, auctionId)).resolves.toMatchObject({
      kind: "ok",
      raffle: {
        status: "drawn",
        tickets: [{ number: 1, displayName: "Сова*" }],
        reveal: { winningTicket: 1 },
      },
    });
    await expect(absent.consoleRaffle(admin, auctionId)).resolves.toEqual({
      kind: "ok",
    });
    await expect(
      refused.consoleRaffle(admin, auctionId),
    ).resolves.not.toHaveProperty("raffle");
  });

  it("reads a discarded auction, a started week and a missing auction as answers", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      discardAuction: async (request: unknown) => {
        sent.push(request);
        return create(DiscardAuctionResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    const late = adapter({
      discardAuction: async () =>
        create(DiscardAuctionResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "auctionAlreadyStarted", value: {} } },
          },
        }),
    });
    const missing = adapter({
      discardAuction: () =>
        Promise.reject(new ConnectError("no", Code.NotFound)),
    });

    await expect(
      accepted.discardAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([{ auctionId, opId }]);
    await expect(
      late.discardAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "already-started" });
    await expect(
      missing.discardAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
  });
});

// Финал ведущего (PER-337): перевод ответов команд финала и чтение последних
// ставок текущего лота.
describe("auction adapter in the final", () => {
  const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
  const second = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
  const rub = (rubles: number) => ({
    minorUnits: BigInt(rubles * 100),
    currency: "RUB",
  });

  it("reads the frozen lineup and the active lot of the final", async () => {
    const console = (status: unknown) =>
      adapter({
        getAuctionConsole: async () =>
          create(GetAuctionConsoleResponseSchema, {
            outcome: {
              case: "console",
              value: {
                auction: create(AuctionSnapshotSchema, {
                  id: auctionId,
                  status: status as never,
                }),
              },
            },
          }),
      }).getAuctionConsole(admin, auctionId);

    await expect(
      console({ case: "lineupFrozen", value: { order: [lotId, second] } }),
    ).resolves.toMatchObject({
      kind: "ok",
      console: { status: "lineup-frozen", lineup: { order: [lotId, second] } },
    });
    await expect(
      console({
        case: "inFinal",
        value: { order: [lotId, second], activeLotId: second },
      }),
    ).resolves.toMatchObject({
      console: {
        status: "final",
        lineup: { order: [lotId, second], activeLotId: second },
      },
    });
    await expect(
      console({ case: "inFinal", value: { order: [lotId, second] } }),
    ).resolves.toMatchObject({
      console: { lineup: { order: [lotId, second] } },
    });
    await expect(
      console({ case: "inFinal", value: { order: [] } }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("sends the lineup in its order and reads every refusal of the announcement", async () => {
    const sent: unknown[] = [];
    const refusing = (
      refusal: MessageInitShape<typeof FreezeFinalLineupRefusalSchema>,
    ) =>
      adapter({
        freezeFinalLineup: async () =>
          create(FreezeFinalLineupResponseSchema, {
            outcome: {
              case: "refused",
              value: create(FreezeFinalLineupRefusalSchema, refusal),
            },
          }),
      });
    const accepted = adapter({
      freezeFinalLineup: async (request) => {
        sent.push(request);
        return create(FreezeFinalLineupResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    const freeze = { auctionId, opId, lotIds: [second, lotId] };

    await expect(accepted.freezeFinalLineup(admin, freeze)).resolves.toEqual({
      kind: "ok",
    });
    expect(sent).toEqual([
      expect.objectContaining({ auctionId, opId, lotIds: [second, lotId] }),
    ]);
    const refusals: [
      NonNullable<
        MessageInitShape<typeof FreezeFinalLineupRefusalSchema>["reason"]
      >,
      string,
    ][] = [
      [{ case: "notMeetupAdministrator", value: {} }, "not-administrator"],
      [{ case: "meetupNotFound", value: {} }, "meetup-not-found"],
      [{ case: "notInBreak", value: {} }, "not-in-break"],
      [{ case: "lineupEmpty", value: {} }, "lineup-empty"],
      [
        { case: "lineupMismatch", value: { heldLotIds: [lotId] } },
        "lineup-mismatch",
      ],
    ];
    for (const [reason, kind] of refusals) {
      await expect(
        refusing({ reason }).freezeFinalLineup(admin, freeze),
      ).resolves.toEqual({ kind });
    }
    await expect(
      adapter({
        freezeFinalLineup: async () =>
          create(FreezeFinalLineupResponseSchema, {}),
      }).freezeFinalLineup(admin, freeze),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("reads a started final, the next lot and a lot still trading", async () => {
    const accepted = adapter({
      startFinal: async () =>
        create(StartFinalResponseSchema, {
          outcome: { case: "accepted", value: {} },
        }),
      startNextLot: async () =>
        create(StartNextLotResponseSchema, {
          outcome: { case: "accepted", value: { lotId } },
        }),
    });
    const busy = adapter({
      startFinal: async () =>
        create(StartFinalResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "lineupNotFrozen", value: {} } },
          },
        }),
      startNextLot: async () =>
        create(StartNextLotResponseSchema, {
          outcome: {
            case: "refused",
            value: {
              reason: { case: "anotherLotActive", value: { lotId: second } },
            },
          },
        }),
    });

    await expect(
      accepted.startFinal(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      accepted.startNextLot(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok", lotId });
    await expect(busy.startFinal(admin, { auctionId, opId })).resolves.toEqual({
      kind: "lineup-not-frozen",
    });
    await expect(
      busy.startNextLot(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "another-lot-active", lotId: second });
  });

  it("sends the new ask and reads the threshold of an ask below the current price", async () => {
    const sent: unknown[] = [];
    const below = adapter({
      advanceAsk: async (request: unknown) => {
        sent.push(request);
        return create(AdvanceAskResponseSchema, {
          outcome: {
            case: "refused",
            value: {
              reason: {
                case: "askBelowCurrentPrice",
                value: { mustExceed: rub(1_000) },
              },
            },
          },
        });
      },
    });

    await expect(
      below.advanceAsk(admin, {
        auctionId,
        lotId,
        opId,
        newAsk: { minorUnits: 90_000, currency: "RUB" },
      }),
    ).resolves.toEqual({
      kind: "ask-below-current-price",
      mustExceed: { minorUnits: 100_000, currency: "RUB" },
    });
    expect(sent).toMatchObject([
      {
        viewer: wireAdmin,
        auctionId,
        lotId,
        opId,
        newAsk: { minorUnits: 90_000n, currency: "RUB" },
      },
    ]);
  });

  it("reads a sale, a close without bids and a lot already closed", async () => {
    const sent: unknown[] = [];
    const winnerId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee";
    const sold = adapter({
      closeLot: async (request: unknown) => {
        sent.push(request);
        return create(CloseLotResponseSchema, {
          outcome: {
            case: "accepted",
            value: {
              result: {
                case: "sold",
                value: { winnerId, price: rub(1_000), bidId: lotId },
              },
            },
          },
        });
      },
    });
    const unsold = adapter({
      closeLot: async () =>
        create(CloseLotResponseSchema, {
          outcome: {
            case: "accepted",
            value: { result: { case: "unsold", value: 1 } },
          },
        }),
    });
    const closed = adapter({
      closeLot: async () =>
        create(CloseLotResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "lotNotOpen", value: {} } },
          },
        }),
    });

    await expect(
      sold.closeLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({
      kind: "ok",
      closure: {
        kind: "sold",
        winnerId,
        price: { minorUnits: 100_000, currency: "RUB" },
      },
    });
    expect(sent).toMatchObject([{ auctionId, lotId, opId }]);
    await expect(
      unsold.closeLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "ok", closure: { kind: "unsold" } });
    await expect(
      closed.closeLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "lot-not-open" });
  });

  it("reads display names and reports a refusal of the names", async () => {
    const refused = vi.fn();
    const named = adapter({
      getDisplayNames: async () => ({ names: { a: { text: "Аня" } } }),
    });
    const failing = createAuctionAdapter(
      {
        getDisplayNames: () =>
          Promise.reject(new ConnectError("no", Code.Unavailable)),
      } as never,
      { onNamesRefused: refused },
    );

    await expect(
      named.displayNames(admin, { auctionId, participantIds: ["a"] }),
    ).resolves.toEqual({ kind: "ok", names: { a: "Аня" } });
    await expect(
      failing.displayNames(admin, { auctionId, participantIds: ["a"] }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(refused).toHaveBeenCalledOnce();
  });

  it("reads the latest bids across the pages, newest first, with their names", async () => {
    const bid = (rubles: number, participantId: string) => ({
      sequence: BigInt(rubles),
      occurredAt: "2026-10-27T18:00:00Z",
      kind: {
        case: "bid" as const,
        value: {
          bidId: lotId,
          participantId,
          amount: rub(rubles),
          origin: {
            case: "manual" as const,
            value: { source: BidSource.BOT },
          },
        },
      },
    });
    const pages: Record<string, unknown> = {
      "": create(ListLotHistoryResponseSchema, {
        entries: [bid(100, "a"), bid(200, "b"), bid(300, "a")],
        nextPageToken: "next",
      }),
      next: create(ListLotHistoryResponseSchema, {
        entries: [bid(400, "c")],
        nextPageToken: "",
      }),
    };
    const asked: unknown[] = [];
    const read = adapter({
      listLotHistory: async (request) =>
        pages[(request as { pageToken: string }).pageToken],
      getDisplayNames: async (request) => {
        asked.push(request);
        return { names: { a: { text: "Аня" }, c: { text: "Света" } } };
      },
    });
    const nameless = adapter({
      listLotHistory: async (request) =>
        pages[(request as { pageToken: string }).pageToken],
      getDisplayNames: () =>
        Promise.reject(new ConnectError("no", Code.Unavailable)),
    });
    const request = {
      auctionId,
      lotId,
      limit: 3,
      extraIds: ["c"],
    };

    await expect(read.recentBids(admin, request)).resolves.toEqual({
      kind: "ok",
      bids: [
        { amount: { minorUnits: 40_000, currency: "RUB" }, participantId: "c" },
        { amount: { minorUnits: 30_000, currency: "RUB" }, participantId: "a" },
        { amount: { minorUnits: 20_000, currency: "RUB" }, participantId: "b" },
      ],
      names: { a: "Аня", c: "Света" },
    });
    expect(asked).toMatchObject([
      { auctionId, participantIds: ["c", "a", "b"] },
    ]);
    await expect(nameless.recentBids(admin, request)).resolves.toMatchObject({
      kind: "ok",
      names: {},
    });
  });
});

// Название лота для уведомления хаба (PER-598): смотрящий несёт только право,
// которое Identity подтвердил, а лот без карточки даёт пустое название.
describe("lot title reader", () => {
  const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
  const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

  it("reads the title as the recipient with the right to bid", async () => {
    const getLot = vi.fn().mockResolvedValue({ card: { title: "Кружка" } });
    await expect(
      createLotTitleReader({ getLot }).lotTitle(identityId, lotId),
    ).resolves.toBe("Кружка");
    expect(getLot).toHaveBeenCalledWith(
      {
        viewer: expect.objectContaining({
          identityId,
          rights: [AccessRight.PLACE_BIDS],
        }),
        lotId,
      },
      expect.anything(),
    );
  });

  it("gives an empty title to a lot without a card", async () => {
    const getLot = vi.fn().mockResolvedValue({});
    await expect(
      createLotTitleReader({ getLot }).lotTitle(identityId, lotId),
    ).resolves.toBe("");
  });
});
