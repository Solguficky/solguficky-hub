import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  AddLotResponseSchema,
  AuctionSnapshotSchema,
  CreateLotCardResponseSchema,
  DraftAuctionResponseSchema,
  EditLotCardResponseSchema,
  GetAuctionConsoleResponseSchema,
  GetMeetupAuctionResponseSchema,
  LotSnapshotSchema,
  ScheduleAuctionResponseSchema,
  ScheduleLotResponseSchema,
  SelectForFinalResponseSchema,
  StartPrebiddingResponseSchema,
} from "../../gen/auction/v1/auction_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import { createAuctionAdapter } from "./client.js";

// Перевод ответов Auction для оболочки сходки (PER-307). Транспорт и токен
// вызывающего проверяет `service-token.test.ts`; здесь — смысл ответа.

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const opId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
const admin = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: ["admin", "auditor"],
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
  scheduleAuction?: Call;
  startPrebidding?: Call;
  selectForFinal?: Call;
  deselectForFinal?: Call;
}) {
  return createAuctionAdapter({
    draftAuction: (rpc.draftAuction ?? notUsed) as never,
    getMeetupAuction: (rpc.getMeetupAuction ?? notUsed) as never,
    createLotCard: (rpc.createLotCard ?? notUsed) as never,
    editLotCard: (rpc.editLotCard ?? notUsed) as never,
    addLot: (rpc.addLot ?? notUsed) as never,
    scheduleLot: (rpc.scheduleLot ?? notUsed) as never,
    getLot: (rpc.getLot ?? notUsed) as never,
    listAuctionLots: notUsed,
    listLotHistory: notUsed,
    getDisplayNames: notUsed,
    placeBid: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getLotImage: notUsed,
    getAuctionConsole: (rpc.getAuctionConsole ?? notUsed) as never,
    scheduleAuction: (rpc.scheduleAuction ?? notUsed) as never,
    startPrebidding: (rpc.startPrebidding ?? notUsed) as never,
    selectForFinal: (rpc.selectForFinal ?? notUsed) as never,
    deselectForFinal: (rpc.deselectForFinal ?? notUsed) as never,
  });
}

describe("auction adapter", () => {
  it("names the auction of the meetup and reads its absence as an answer", async () => {
    const found = adapter({
      getMeetupAuction: async () =>
        create(GetMeetupAuctionResponseSchema, {
          auction: create(AuctionSnapshotSchema, { id: auctionId }),
        }),
    });
    const absent = adapter({
      getMeetupAuction: async () => create(GetMeetupAuctionResponseSchema, {}),
    });

    await expect(found.getMeetupAuction(admin, meetupId)).resolves.toEqual({
      kind: "ok",
      auctionId,
    });
    await expect(absent.getMeetupAuction(admin, meetupId)).resolves.toEqual({
      kind: "ok",
    });
  });

  it("sends the meetup, the key of the press and only the roles Auction knows", async () => {
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
        viewer: {
          identityId: admin.identityId,
          globalRoles: [GlobalRole.ADMIN],
        },
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
      viewer: { identityId: admin.identityId, globalRoles: [GlobalRole.ADMIN] },
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
        viewer: {
          identityId: admin.identityId,
          globalRoles: [GlobalRole.ADMIN],
        },
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
        step: { minorUnits: 10_000, currency: "RUB" },
      }),
    ).resolves.toEqual({ kind: "ok" });
    expect(scheduleLot).toHaveBeenCalledWith(
      {
        viewer: {
          identityId: admin.identityId,
          globalRoles: [GlobalRole.ADMIN],
        },
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
          step: { minorUnits: 100, currency: "RUB" },
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
        step: { minorUnits: 100, currency: "RUB" },
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
        step: { minorUnits: 100, currency: "RUB" },
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
        week: { opensAt: week.opensAt, closesAt: week.closesAt, final: true },
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
});
