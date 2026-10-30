import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionState_BreakSchema,
  AuctionState_DraftSchema,
  AuctionState_PrebiddingSchema,
  AuctionState_ScheduledSchema,
} from "../../../../gen/auction/v1/auction_events_pb.js";
import {
  BidSource,
  FulfillmentMethod,
  LotSaleSchema,
} from "../../../../gen/auction/v1/auction_pb.js";
import {
  AddLotResponseSchema,
  AdvanceAskResponseSchema,
  AssignRaffleWinnerResponseSchema,
  AuctionSnapshotSchema,
  CancelAuctionResponseSchema,
  ChangeRafflePrizeResponseSchema,
  CloseLotResponseSchema,
  CreateLotCardResponseSchema,
  DeleteLotSetResponseSchema,
  DiscardAuctionResponseSchema,
  DraftAuctionResponseSchema,
  EditLotCardResponseSchema,
  FreezeFinalLineupRefusalSchema,
  FreezeFinalLineupResponseSchema,
  GetAuctionConsoleResponseSchema,
  GetAuctionDaySummaryResponseSchema,
  GetAuctionLotStatisticsResponseSchema,
  GetMeetupAuctionResponseSchema,
  GetRaffleResponseSchema,
  HideAuctionResponseSchema,
  ListAuctionLotsResponseSchema,
  ListAuctionNamesResponseSchema,
  ListAuctionsResponseSchema,
  ListLotHistoryResponseSchema,
  LotSnapshotSchema,
  PlaceBidResponseSchema,
  PublishAuctionResponseSchema,
  RaffleSchema,
  RaffleStatus,
  RemoveLotResponseSchema,
  RemoveRafflePrizePhotoResponseSchema,
  SaveLotSetResponseSchema,
  ScheduleAuctionResponseSchema,
  ScheduleLotResponseSchema,
  SelectForFinalResponseSchema,
  SetFinalTimeResponseSchema,
  SetLotLayoutResponseSchema,
  SetRafflePrizePhotoResponseSchema,
  StartFinalResponseSchema,
  StartNextLotResponseSchema,
  StartPrebiddingResponseSchema,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import { AccessRight } from "../../../../gen/identity/v1/access_pb.js";
import { createAuctionAdapter, createLotInfoReader } from "./client.js";

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
  getAuctionDaySummary?: Call;
  scheduleAuction?: Call;
  startPrebidding?: Call;
  discardAuction?: Call;
  cancelAuction?: Call;
  listAuctionLots?: Call;
  publishAuction?: Call;
  hideAuction?: Call;
  setFinalTime?: Call;
  saveLotSet?: Call;
  setLotLayout?: Call;
  deleteLotSet?: Call;
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
  assignRaffleWinner?: Call;
  changeRafflePrize?: Call;
  listAuctionNames?: Call;
  placeBid?: Call;
  launchStepWindow?: Call;
  createHappyHourPeriod?: Call;
  deleteHappyHourPeriod?: Call;
  setHappyHourLotTerms?: Call;
  clearHappyHourLotTerms?: Call;
  previewParticipantRemoval?: Call;
  removeParticipant?: Call;
  listAuctionInvoices?: Call;
  markInvoicePaid?: Call;
  markInvoiceHandedOver?: Call;
  setPaymentInstructions?: Call;
  setPromoVideo?: Call;
  listMyInvoices?: Call;
  removeLot?: Call;
  getLotPhoto?: Call;
  addLotPhoto?: Call;
  removeLotPhoto?: Call;
  getRafflePrizePhoto?: Call;
  setRafflePrizePhoto?: Call;
  removeRafflePrizePhoto?: Call;
}) {
  return createAuctionAdapter({
    draftAuction: (rpc.draftAuction ?? notUsed) as never,
    getMeetupAuction: (rpc.getMeetupAuction ?? notUsed) as never,
    listAuctions: (rpc.listAuctions ?? notUsed) as never,
    createLotCard: (rpc.createLotCard ?? notUsed) as never,
    editLotCard: (rpc.editLotCard ?? notUsed) as never,
    addLot: (rpc.addLot ?? notUsed) as never,
    removeLot: (rpc.removeLot ?? notUsed) as never,
    scheduleLot: (rpc.scheduleLot ?? notUsed) as never,
    getLot: (rpc.getLot ?? notUsed) as never,
    listAuctionLots: (rpc.listAuctionLots ?? notUsed) as never,
    listLotHistory: (rpc.listLotHistory ?? notUsed) as never,
    getDisplayNames: (rpc.getDisplayNames ?? notUsed) as never,
    listAuctionNames: (rpc.listAuctionNames ?? notUsed) as never,
    placeBid: (rpc.placeBid ?? notUsed) as never,
    withdrawProxyLimit: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getAuction: notUsed,
    getRaffle: (rpc.getRaffle ?? notUsed) as never,
    assignRaffleWinner: (rpc.assignRaffleWinner ?? notUsed) as never,
    changeRafflePrize: (rpc.changeRafflePrize ?? notUsed) as never,
    registerForRaffle: notUsed,
    cancelRaffleRegistration: notUsed,
    getMyPredictions: notUsed,
    getPredictionResults: notUsed,
    getAuctionDayChronicle: notUsed,
    getAuctionChronicle: notUsed,
    submitPrediction: notUsed,
    getLotImage: notUsed,
    getLotPhoto: (rpc.getLotPhoto ?? notUsed) as never,
    addLotPhoto: (rpc.addLotPhoto ?? notUsed) as never,
    removeLotPhoto: (rpc.removeLotPhoto ?? notUsed) as never,
    getRafflePrizePhoto: (rpc.getRafflePrizePhoto ?? notUsed) as never,
    setRafflePrizePhoto: (rpc.setRafflePrizePhoto ?? notUsed) as never,
    removeRafflePrizePhoto: (rpc.removeRafflePrizePhoto ?? notUsed) as never,
    getAuctionConsole: (rpc.getAuctionConsole ?? notUsed) as never,
    getAuctionLotStatistics: (rpc.getAuctionLotStatistics ?? notUsed) as never,
    getAuctionDaySummary: (rpc.getAuctionDaySummary ?? notUsed) as never,
    scheduleAuction: (rpc.scheduleAuction ?? notUsed) as never,
    launchStepWindow: (rpc.launchStepWindow ?? notUsed) as never,
    createHappyHourPeriod: (rpc.createHappyHourPeriod ?? notUsed) as never,
    deleteHappyHourPeriod: (rpc.deleteHappyHourPeriod ?? notUsed) as never,
    setHappyHourLotTerms: (rpc.setHappyHourLotTerms ?? notUsed) as never,
    clearHappyHourLotTerms: (rpc.clearHappyHourLotTerms ?? notUsed) as never,
    startPrebidding: (rpc.startPrebidding ?? notUsed) as never,
    discardAuction: (rpc.discardAuction ?? notUsed) as never,
    cancelAuction: (rpc.cancelAuction ?? notUsed) as never,
    publishAuction: (rpc.publishAuction ?? notUsed) as never,
    hideAuction: (rpc.hideAuction ?? notUsed) as never,
    setFinalTime: (rpc.setFinalTime ?? notUsed) as never,
    saveLotSet: (rpc.saveLotSet ?? notUsed) as never,
    deleteLotSet: (rpc.deleteLotSet ?? notUsed) as never,
    setLotLayout: (rpc.setLotLayout ?? notUsed) as never,
    selectForFinal: (rpc.selectForFinal ?? notUsed) as never,
    deselectForFinal: (rpc.deselectForFinal ?? notUsed) as never,
    freezeFinalLineup: (rpc.freezeFinalLineup ?? notUsed) as never,
    startFinal: (rpc.startFinal ?? notUsed) as never,
    startNextLot: (rpc.startNextLot ?? notUsed) as never,
    advanceAsk: (rpc.advanceAsk ?? notUsed) as never,
    closeLot: (rpc.closeLot ?? notUsed) as never,
    previewParticipantRemoval: (rpc.previewParticipantRemoval ??
      notUsed) as never,
    removeParticipant: (rpc.removeParticipant ?? notUsed) as never,
    listAuctionInvoices: (rpc.listAuctionInvoices ?? notUsed) as never,
    markInvoicePaid: (rpc.markInvoicePaid ?? notUsed) as never,
    markInvoiceHandedOver: (rpc.markInvoiceHandedOver ?? notUsed) as never,
    setPaymentInstructions: (rpc.setPaymentInstructions ?? notUsed) as never,
    setPromoVideo: (rpc.setPromoVideo ?? notUsed) as never,
    listMyInvoices: (rpc.listMyInvoices ?? notUsed) as never,
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

  it("sends the removal of the image as remove_image with both texts", async () => {
    const editLotCard = vi.fn(async () =>
      create(EditLotCardResponseSchema, {
        outcome: { case: "accepted", value: { title: "Ваза" } },
      }),
    );
    const lots = adapter({ editLotCard });

    await expect(
      lots.editLotCard(admin, { ...card, removeImage: true }),
    ).resolves.toEqual({ kind: "ok" });
    expect(editLotCard).toHaveBeenCalledWith(
      {
        ...card,
        viewer: wireAdmin,
        imageChange: { case: "removeImage", value: {} },
      },
      expect.anything(),
    );
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
    const closed = adapter({
      editLotCard: async () => refused(EditLotCardResponseSchema, "cardClosed"),
    });
    await expect(closed.editLotCard(admin, card)).resolves.toEqual({
      kind: "card-closed",
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

  it.each([
    ["notMeetupAdministrator", { kind: "not-administrator" }],
    ["meetupNotFound", { kind: "meetup-not-found" }],
    ["meetupCancelled", { kind: "meetup-cancelled" }],
    ["lotsFrozen", { kind: "lots-frozen" }],
    ["lotNotInAuction", { kind: "lot-not-in-auction" }],
  ] as const)(
    "reads the %s refusal of a removal as a final answer",
    async (reason, expected) => {
      const lots = adapter({
        removeLot: async () => refused(RemoveLotResponseSchema, reason),
      });

      await expect(
        lots.removeLot(admin, { auctionId, lotId, opId }),
      ).resolves.toEqual(expected);
    },
  );

  it("sends the removal of a lot with its key and reads an auction without a journal", async () => {
    const removeLot = vi.fn(async () =>
      create(RemoveLotResponseSchema, {
        outcome: { case: "accepted", value: {} },
      }),
    );
    const missing = adapter({
      removeLot: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });

    await expect(
      adapter({ removeLot }).removeLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(removeLot).toHaveBeenCalledWith(
      { viewer: wireAdmin, auctionId, lotId, opId },
      expect.anything(),
    );
    await expect(
      missing.removeLot(admin, { auctionId, lotId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
  });

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
  const lotSetId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34bb";
  const week = {
    auctionId,
    opId,
    opensAt: "2026-10-20T15:00:00Z",
    closesAt: "2026-10-26T21:00:00Z",
    windows: [],
    raffleClosesAt: undefined,
    rafflePrize: undefined,
    paymentTermSeconds: undefined,
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

  // Срок оплаты счёта (PER-722): едет секундами в конфигурации, а отказ
  // Auction о пределе — ответ человеку, а не дефект.
  it("sends the payment term with the week and reads its refusal", async () => {
    const scheduleAuction = vi.fn(async (_request: unknown) =>
      create(ScheduleAuctionResponseSchema, {
        outcome: { case: "accepted", value: {} },
      }),
    );
    await adapter({ scheduleAuction }).scheduleAuction(admin, {
      ...week,
      final: false,
      paymentTermSeconds: 86_400,
    });
    const sent = scheduleAuction.mock.calls[0]?.[0] as {
      config: Record<string, unknown>;
    };
    expect(sent.config).toMatchObject({ paymentTermSeconds: 86_400n });

    await expect(
      adapter({
        scheduleAuction: async () =>
          create(ScheduleAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: {
                reason: {
                  case: "configInvalid",
                  value: {
                    reason: { case: "paymentTermOutOfRange", value: {} },
                  },
                },
              },
            },
          }),
      }).scheduleAuction(admin, { ...week, final: false }),
    ).resolves.toEqual({ kind: "payment-term-out-of-range" });
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
    // Дефект перевода человек видит как «недоступно», а не пульт с выдумкой;
    // исход называет дефект соседа, а не недоступность (PER-811).
    await expect(reading(undefined)).resolves.toMatchObject({
      kind: "invalid",
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
              // Неполный сет из одного лота (PER-509): пульт его видит.
              lotSets: [{ lotSetId, name: "Кружки", lotIds: [lotId] }],
            },
          },
        }),
    });

    await expect(read.getAuctionConsole(admin, auctionId)).resolves.toEqual({
      kind: "ok",
      console: {
        auctionId,
        status: "prebidding",
        hidden: false,
        week: {
          opensAt: week.opensAt,
          closesAt: week.closesAt,
          final: true,
          windows: [],
        },
        launchedWindows: [],
        happyHourPeriods: [],
        lots: [
          {
            lot: expect.objectContaining({
              lotId,
              status: {
                kind: "trading",
                currentPrice: { minorUnits: 120_000, currency: "RUB" },
                extensionsUsed: 0,
                phase: "online",
              },
            }),
            bidCount: 3,
            markedForFinal: true,
            overdue: true,
          },
        ],
        lotSets: [{ lotSetId, name: "Кружки", lotIds: [lotId] }],
      },
    });
  });

  // PER-734: числа розыгрыша и прогнозов — только агрегаты; без полей их нет.
  it("reads the raffle registrations and the predictions tally of the console", async () => {
    const reading = (
      extra: Partial<{
        raffleRegistrations: number;
        predictions: { participants: number; answers: number };
      }>,
    ) =>
      adapter({
        getAuctionConsole: async () =>
          create(GetAuctionConsoleResponseSchema, {
            outcome: {
              case: "console",
              value: {
                auction: {
                  id: auctionId,
                  status: { case: "prebidding", value: {} },
                },
                ...extra,
              },
            },
          }),
      }).getAuctionConsole(admin, auctionId);

    await expect(
      reading({
        raffleRegistrations: 12,
        predictions: { participants: 5, answers: 17 },
      }),
    ).resolves.toMatchObject({
      kind: "ok",
      console: {
        raffleRegistrations: 12,
        predictionTally: { participants: 5, answers: 17 },
      },
    });
    const bare = await reading({});
    expect(bare.kind === "ok" && bare.console).not.toHaveProperty(
      "raffleRegistrations",
    );
    expect(bare.kind === "ok" && bare.console).not.toHaveProperty(
      "predictionTally",
    );
    // Ответов меньше, чем людей, не бывает: это дефект соседа с причиной, а не
    // недоступность (PER-811).
    await expect(
      reading({ predictions: { participants: 3, answers: 1 } }),
    ).resolves.toMatchObject({
      kind: "invalid",
      cause: new Error("prediction tally with fewer answers than participants"),
    });
  });

  // PER-811: ответ пришёл, но перевод его отверг — повтор не вылечит, и запись
  // границы называет причину; настоящая недоступность остаётся недоступностью.
  it("reads a response the translation rejects as a defect, and a dropped call as unavailable", async () => {
    const broken = adapter({
      getAuctionConsole: async () =>
        create(GetAuctionConsoleResponseSchema, {
          outcome: { case: "console", value: {} },
        }),
    });
    const down = adapter({
      getAuctionConsole: () =>
        Promise.reject(new ConnectError("down", Code.Unavailable)),
    });
    // Бросок до ответа — не ConnectError, но и не перевод: ответа не было, и
    // это отказ вызова, а не дефект соседа.
    const unwrapped = adapter({
      getAuctionConsole: () => Promise.reject(new Error("socket hang up")),
    });

    await expect(broken.getAuctionConsole(admin, auctionId)).resolves.toEqual({
      kind: "invalid",
      cause: new Error("auction console without auction"),
    });
    await expect(
      down.getAuctionConsole(admin, auctionId),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      unwrapped.getAuctionConsole(admin, auctionId),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  // Рост — разность цен: ставка по стартовой окна ниже обычной стартовой даёт
  // отрицательный рост, и это ответ, а не дефект (PER-811).
  it("reads a negative price growth of the statistics and of the day summary", async () => {
    const read = adapter({
      getAuctionLotStatistics: async () =>
        create(GetAuctionLotStatisticsResponseSchema, {
          outcome: {
            case: "statistics",
            value: {
              lots: [
                {
                  lotId,
                  bidCount: 1n,
                  uniqueParticipantCount: 1n,
                  priceGrowth: { minorUnits: -15_000n, currency: "RUB" },
                },
              ],
            },
          },
        }),
      getAuctionDaySummary: async () =>
        create(GetAuctionDaySummaryResponseSchema, {
          outcome: {
            case: "summary",
            value: {
              lots: [
                {
                  lotId,
                  bidCount: 1n,
                  maxPrice: { minorUnits: 15_000n, currency: "RUB" },
                  growth: { minorUnits: -15_000n, currency: "RUB" },
                },
              ],
            },
          },
        }),
    });

    await expect(
      read.getAuctionLotStatistics(admin, auctionId),
    ).resolves.toMatchObject({
      kind: "ok",
      lots: [{ priceGrowth: { minorUnits: -15_000, currency: "RUB" } }],
    });
    await expect(
      read.getAuctionDaySummary(admin, {
        auctionId,
        from: "2026-10-27T21:00:00Z",
        until: "2026-10-28T21:00:00Z",
      }),
    ).resolves.toMatchObject({
      kind: "ok",
      lots: [
        {
          maxPrice: { minorUnits: 15_000, currency: "RUB" },
          growth: { minorUnits: -15_000, currency: "RUB" },
        },
      ],
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

  // PER-669: идущий аукцион — открытый, даже если запланированный стоит
  // раньше по началу торгов: слот торгов не дал тому открыться.
  it("prefers an opened auction over a scheduled one as the current auction", async () => {
    const holder = "0190f2a0-0000-7000-8000-000000000021";
    const reading = adapter({
      listAuctions: async () =>
        create(ListAuctionsResponseSchema, {
          auctions: [
            create(AuctionSnapshotSchema, {
              id: auctionId,
              status: {
                case: "scheduled",
                value: create(AuctionState_ScheduledSchema, {}),
              },
            }),
            create(AuctionSnapshotSchema, {
              id: holder,
              status: {
                case: "prebidding",
                value: create(AuctionState_PrebiddingSchema, {}),
              },
            }),
          ],
          nextPageToken: "",
        }),
    });

    await expect(reading.currentAuction(admin)).resolves.toEqual({
      kind: "ok",
      auctionId: holder,
      auction: { auctionId: holder, stage: "prebidding", final: false },
    });
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

  // Ручной итог розыгрыша (PER-727): принятый — розыгрыш с итогом, каждый
  // именованный отказ — свой ответ, а в Auction едут смотрящий, номер и ключ.
  it("assigns the raffle winner and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      assignRaffleWinner: async (request: unknown) => {
        sent.push(request);
        return create(AssignRaffleWinnerResponseSchema, {
          outcome: {
            case: "accepted",
            value: create(RaffleSchema, {
              auctionId,
              status: RaffleStatus.DRAWN,
              closesAt: "2026-10-05T16:12:00Z",
              drawnByHand: true,
              tickets: [{ number: 1 }, { number: 2, displayName: "Сова*" }],
              reveal: { seed: "cd".repeat(32), winningTicket: 2 },
            }),
          },
        });
      },
    });
    await expect(
      accepted.assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
    ).resolves.toMatchObject({
      kind: "ok",
      raffle: {
        status: "drawn",
        drawnByHand: true,
        reveal: { winningTicket: 2 },
      },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        auctionId,
        ticket: 2,
        opId,
      }),
    ]);

    const refusals = [
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
      [{ case: "meetupCancelled", value: {} }, { kind: "meetup-cancelled" }],
      [{ case: "raffleNotFound", value: {} }, { kind: "raffle-not-found" }],
      [
        { case: "notAwaitingWinner", value: {} },
        { kind: "not-awaiting-winner" },
      ],
      [
        { case: "ticketNotInPool", value: { tickets: 12 } },
        { kind: "ticket-not-in-pool", tickets: 12 },
      ],
      [
        { case: "alreadyDrawn", value: { winningTicket: 3 } },
        { kind: "already-drawn", winningTicket: 3 },
      ],
    ] as const;
    for (const [reason, result] of refusals) {
      await expect(
        adapter({
          assignRaffleWinner: async () =>
            create(AssignRaffleWinnerResponseSchema, {
              outcome: { case: "refused", value: { reason } },
            }),
        }).assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
      ).resolves.toEqual(result);
    }

    await expect(
      adapter({
        assignRaffleWinner: async () =>
          create(AssignRaffleWinnerResponseSchema, {}),
      }).assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        assignRaffleWinner: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
    // Чужой ключ (ALREADY_EXISTS) — дефект края, а не отказ человеку.
    await expect(
      adapter({
        assignRaffleWinner: () =>
          Promise.reject(new ConnectError("op", Code.AlreadyExists)),
      }).assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        assignRaffleWinner: () =>
          Promise.reject(new ConnectError("down", Code.Unavailable)),
      }).assignRaffleWinner(admin, { auctionId, ticket: 2, opId }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  // Смена приза идущего розыгрыша (PER-737): принятая — розыгрыш с новым
  // призом, каждый именованный отказ — свой ответ, а в Auction едут
  // смотрящий, текст и ключ.
  it("changes the raffle prize and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      changeRafflePrize: async (request: unknown) => {
        sent.push(request);
        return create(ChangeRafflePrizeResponseSchema, {
          outcome: {
            case: "accepted",
            value: create(RaffleSchema, {
              auctionId,
              status: RaffleStatus.OPEN,
              closesAt: "2026-10-05T16:12:00Z",
              rafflePrize: "кружка и брелок",
            }),
          },
        });
      },
    });
    const command = { auctionId, prize: "кружка и брелок", opId };
    await expect(
      accepted.changeRafflePrize(admin, command),
    ).resolves.toMatchObject({
      kind: "ok",
      raffle: { status: "open", prize: "кружка и брелок" },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        auctionId,
        prize: "кружка и брелок",
        opId,
      }),
    ]);

    const refusals = [
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
      [{ case: "meetupCancelled", value: {} }, { kind: "meetup-cancelled" }],
      [{ case: "raffleNotFound", value: {} }, { kind: "raffle-not-found" }],
      [{ case: "prizeBlank", value: {} }, { kind: "prize-blank" }],
      [{ case: "prizeTooLong", value: {} }, { kind: "prize-too-long" }],
      [
        { case: "alreadyDrawn", value: { winningTicket: 3 } },
        { kind: "already-drawn", winningTicket: 3 },
      ],
      [{ case: "withoutResult", value: {} }, { kind: "without-result" }],
    ] as const;
    for (const [reason, result] of refusals) {
      await expect(
        adapter({
          changeRafflePrize: async () =>
            create(ChangeRafflePrizeResponseSchema, {
              outcome: { case: "refused", value: { reason } },
            }),
        }).changeRafflePrize(admin, command),
      ).resolves.toEqual(result);
    }

    await expect(
      adapter({
        changeRafflePrize: async () =>
          create(ChangeRafflePrizeResponseSchema, {}),
      }).changeRafflePrize(admin, command),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        changeRafflePrize: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).changeRafflePrize(admin, command),
    ).resolves.toEqual({ kind: "auction-not-found" });
    await expect(
      adapter({
        changeRafflePrize: () =>
          Promise.reject(new ConnectError("down", Code.Unavailable)),
      }).changeRafflePrize(admin, command),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  // Фото приза идущего розыгрыша (PER-773): принятая — розыгрыш с фото,
  // каждый именованный отказ — свой ответ, а в Auction едут смотрящий,
  // аукцион, ключ фото и байты.
  it("sets and removes the raffle prize photo and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const raffle = create(RaffleSchema, {
      auctionId,
      status: RaffleStatus.OPEN,
      closesAt: "2026-10-05T16:12:00Z",
      prizePhoto: { photoId: opId, version: "v1" },
    });
    const accepted = adapter({
      setRafflePrizePhoto: async (request: unknown) => {
        sent.push(request);
        return create(SetRafflePrizePhotoResponseSchema, {
          outcome: { case: "accepted", value: raffle },
        });
      },
      removeRafflePrizePhoto: async (request: unknown) => {
        sent.push(request);
        return create(RemoveRafflePrizePhotoResponseSchema, {
          outcome: {
            case: "accepted",
            value: create(RaffleSchema, {
              auctionId,
              status: RaffleStatus.OPEN,
              closesAt: "2026-10-05T16:12:00Z",
            }),
          },
        });
      },
    });
    const image = new Uint8Array([1, 2, 3]);
    const command = { auctionId, photoId: opId, image };
    await expect(
      accepted.setRafflePrizePhoto(admin, command),
    ).resolves.toMatchObject({
      kind: "ok",
      raffle: { prizePhoto: { photoId: opId, version: "v1" } },
    });
    const removed = await accepted.removeRafflePrizePhoto(admin, {
      auctionId,
      opId,
    });
    expect(removed.kind === "ok" && removed.raffle.prizePhoto).toBe(undefined);
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        auctionId,
        photoId: opId,
        photo: expect.objectContaining({ content: image }),
      }),
      expect.objectContaining({ viewer: wireAdmin, auctionId, opId }),
    ]);

    const refusals = [
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
      [{ case: "meetupCancelled", value: {} }, { kind: "meetup-cancelled" }],
      [{ case: "raffleNotFound", value: {} }, { kind: "raffle-not-found" }],
      [
        { case: "alreadyDrawn", value: { winningTicket: 3 } },
        { kind: "already-drawn" },
      ],
      [{ case: "withoutResult", value: {} }, { kind: "without-result" }],
      [
        { case: "imageTooLarge", value: { maxBytes: 1024n } },
        { kind: "image-too-large", maxBytes: 1024 },
      ],
      [{ case: "unsupportedImage", value: {} }, { kind: "unsupported-image" }],
      [{ case: "photoConflict", value: {} }, { kind: "photo-conflict" }],
    ] as const;
    for (const [reason, result] of refusals) {
      await expect(
        adapter({
          setRafflePrizePhoto: async () =>
            create(SetRafflePrizePhotoResponseSchema, {
              outcome: { case: "refused", value: { reason } },
            }),
        }).setRafflePrizePhoto(admin, command),
      ).resolves.toEqual(result);
    }
    // Отказ изображения у снятия — дефект соседа.
    await expect(
      adapter({
        removeRafflePrizePhoto: async () =>
          create(RemoveRafflePrizePhotoResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: "unsupportedImage", value: {} } },
            },
          }),
      }).removeRafflePrizePhoto(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        setRafflePrizePhoto: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).setRafflePrizePhoto(admin, command),
    ).resolves.toEqual({ kind: "auction-not-found" });
  });

  // Отмена после старта торгов (PER-606): каждый именованный отказ — свой
  // ответ, принятая — `ok`, и в Auction едут смотрящий и ключ отмены.
  it("reads the cancel of an auction and its named refusals", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      cancelAuction: async (request) => {
        sent.push(request);
        return create(CancelAuctionResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    await expect(
      accepted.cancelAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([{ viewer: wireAdmin, auctionId, opId }]);

    for (const [reason, kind] of [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
      ["auctionNotStarted", "not-started"],
      ["auctionAlreadyFinished", "already-finished"],
    ] as const) {
      const refused = adapter({
        cancelAuction: async () =>
          create(CancelAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
      });

      await expect(
        refused.cancelAuction(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }
  });

  // Число проданных лотов для подтверждения отмены сходки: реестр по
  // страницам, проданный — по статусу снимка; бесконечный реестр — дефект.
  it("counts the sold lots of an auction over the pages of its registry", async () => {
    const sold = (lotId: string) =>
      create(LotSnapshotSchema, {
        id: lotId,
        status: {
          case: "sold",
          value: create(LotSaleSchema, {
            winnerId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
            price: { minorUnits: 100_000n, currency: "RUB" },
          }),
        },
      });
    const pages = adapter({
      listAuctionLots: async (request) =>
        (request as { pageToken: string }).pageToken === ""
          ? create(ListAuctionLotsResponseSchema, {
              lots: [
                sold("0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401"),
                create(LotSnapshotSchema, {
                  id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402",
                }),
              ],
              nextPageToken: "next",
            })
          : create(ListAuctionLotsResponseSchema, {
              lots: [sold("0198f2a4-7c1e-7d3a-9b21-4f8e12ab3403")],
            }),
    });
    const looping = adapter({
      listAuctionLots: async () =>
        create(ListAuctionLotsResponseSchema, { nextPageToken: "again" }),
    });

    await expect(pages.soldLots(admin, auctionId)).resolves.toEqual({
      kind: "ok",
      sold: 2,
    });
    await expect(looping.soldLots(admin, auctionId)).resolves.toMatchObject({
      kind: "invalid",
    });
  });

  it("reads a start refused for a cancelled or a hidden meetup as its own answer", async () => {
    for (const [reason, kind] of [
      ["meetupCancelled", "meetup-cancelled"],
      ["meetupHidden", "meetup-hidden"],
    ] as const) {
      const started = adapter({
        startPrebidding: async () =>
          create(StartPrebiddingResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
      });

      await expect(
        started.startPrebidding(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }
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

  it("reads every visibility refusal as an answer, for both commands", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      publishAuction: async (request: unknown) => {
        sent.push(request);
        return create(PublishAuctionResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
      hideAuction: async (request: unknown) => {
        sent.push(request);
        return create(HideAuctionResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    await expect(
      accepted.publishAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      accepted.hideAuction(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([
      { auctionId, opId },
      { auctionId, opId },
    ]);

    const reasons = [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
      ["meetupCancelled", "meetup-cancelled"],
      ["auctionAlreadyStarted", "already-started"],
    ] as const;
    for (const [reason, kind] of reasons) {
      const refused = adapter({
        publishAuction: async () =>
          create(PublishAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
        hideAuction: async () =>
          create(HideAuctionResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
      });
      await expect(
        refused.publishAuction(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
      await expect(
        refused.hideAuction(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }

    const odd = adapter({
      publishAuction: async () => create(PublishAuctionResponseSchema, {}),
      hideAuction: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    await expect(
      odd.publishAuction(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(odd.hideAuction(admin, { auctionId, opId })).resolves.toEqual({
      kind: "auction-not-found",
    });
  });

  // Ориентировочное время финала (PER-663): принятие и именованные отказы.
  it("reads every refusal of the final time as an answer", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      setFinalTime: async (request: unknown) => {
        sent.push(request);
        return create(SetFinalTimeResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    await expect(
      accepted.setFinalTime(admin, {
        auctionId,
        opId,
        finalAt: "2026-10-31T16:00:00Z",
      }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([
      { auctionId, opId, finalAt: "2026-10-31T16:00:00Z" },
    ]);

    const reasons = [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
      ["meetupCancelled", "meetup-cancelled"],
      ["finalAlreadyStarted", "final-already-started"],
      ["auctionAlreadyFinished", "auction-already-finished"],
      ["auctionAlreadyCancelled", "auction-already-cancelled"],
    ] as const;
    for (const [reason, kind] of reasons) {
      const refused = adapter({
        setFinalTime: async () =>
          create(SetFinalTimeResponseSchema, {
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
      });
      await expect(
        refused.setFinalTime(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }

    const odd = adapter({
      setFinalTime: async () => create(SetFinalTimeResponseSchema, {}),
    });
    await expect(
      odd.setFinalTime(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  // Сеты лотов (PER-509): состав уходит целиком, отказ лота несёт лот, а лот
  // чужого сета — ещё и сет.
  it("sends a lot set whole and reads every lot set refusal as an answer", async () => {
    const sent: unknown[] = [];
    const set = { auctionId, lotSetId, name: "Кружки", lotIds: [lotId], opId };
    const accepted = adapter({
      saveLotSet: async (request: unknown) => {
        sent.push(request);
        return create(SaveLotSetResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
      deleteLotSet: async (request: unknown) => {
        sent.push(request);
        return create(DeleteLotSetResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    await expect(accepted.saveLotSet(admin, set)).resolves.toEqual({
      kind: "ok",
    });
    await expect(
      accepted.deleteLotSet(admin, { auctionId, lotSetId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([
      {
        viewer: { identityId: admin.identityId },
        auctionId,
        lotSetId,
        name: "Кружки",
        lotIds: [lotId],
        opId,
      },
      { viewer: { identityId: admin.identityId }, auctionId, lotSetId, opId },
    ]);

    const saveRefusal = (reason: unknown) =>
      adapter({
        saveLotSet: async () =>
          create(SaveLotSetResponseSchema, {
            outcome: { case: "refused", value: { reason } as never },
          }),
      }).saveLotSet(admin, set);
    const saves = [
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
      [{ case: "meetupCancelled", value: {} }, { kind: "meetup-cancelled" }],
      [{ case: "lotsFrozen", value: {} }, { kind: "lots-frozen" }],
      [{ case: "nameEmpty", value: {} }, { kind: "name-empty" }],
      [
        { case: "lotNotInAuction", value: { lotId } },
        { kind: "lot-not-in-auction", lotId },
      ],
      [
        { case: "lotInAnotherSet", value: { lotId, lotSetId } },
        { kind: "lot-in-another-set", lotId, lotSetId },
      ],
    ] as const;
    for (const [reason, result] of saves) {
      await expect(saveRefusal(reason)).resolves.toEqual(result);
    }

    const deleteRefusal = (reason: unknown) =>
      adapter({
        deleteLotSet: async () =>
          create(DeleteLotSetResponseSchema, {
            outcome: { case: "refused", value: { reason } as never },
          }),
      }).deleteLotSet(admin, { auctionId, lotSetId, opId });
    const deletes = [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
      ["meetupCancelled", "meetup-cancelled"],
      ["lotsFrozen", "lots-frozen"],
      ["lotSetNotFound", "lot-set-not-found"],
    ] as const;
    for (const [reason, kind] of deletes) {
      await expect(deleteRefusal({ case: reason, value: {} })).resolves.toEqual(
        { kind },
      );
    }

    const odd = adapter({
      saveLotSet: async () => create(SaveLotSetResponseSchema, {}),
      deleteLotSet: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    await expect(odd.saveLotSet(admin, set)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(
      odd.deleteLotSet(admin, { auctionId, lotSetId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
  });

  // Порядок и разделы ленты (PER-719): раскладка уходит целиком, отказ лота
  // несёт лот.
  it("sends the lot layout whole and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const layout = {
      lotIds: [lotId],
      sections: [{ sectionId: 1, name: "Книги", lotIds: [] }],
    };
    const accepted = adapter({
      setLotLayout: async (request: unknown) => {
        sent.push(request);
        return create(SetLotLayoutResponseSchema, {
          outcome: { case: "accepted", value: {} },
        });
      },
    });
    await expect(
      accepted.setLotLayout(admin, { auctionId, layout, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toMatchObject([
      {
        viewer: { identityId: admin.identityId },
        auctionId,
        opId,
        layout: {
          lotIds: [lotId],
          sections: [{ sectionId: 1, name: "Книги", lotIds: [] }],
        },
      },
    ]);

    const refusal = (reason: unknown) =>
      adapter({
        setLotLayout: async () =>
          create(SetLotLayoutResponseSchema, {
            outcome: { case: "refused", value: { reason } as never },
          }),
      }).setLotLayout(admin, { auctionId, layout, opId });
    const refusals = [
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
      [{ case: "meetupCancelled", value: {} }, { kind: "meetup-cancelled" }],
      [
        { case: "finalAlreadyStarted", value: {} },
        { kind: "final-already-started" },
      ],
      [
        { case: "auctionAlreadyFinished", value: {} },
        { kind: "auction-already-finished" },
      ],
      [
        { case: "auctionAlreadyCancelled", value: {} },
        { kind: "auction-already-cancelled" },
      ],
      [
        { case: "lotNotInAuction", value: { lotId } },
        { kind: "lot-not-in-auction", lotId },
      ],
    ] as const;
    for (const [reason, result] of refusals) {
      await expect(refusal(reason)).resolves.toEqual(result);
    }

    const odd = adapter({
      setLotLayout: async () => create(SetLotLayoutResponseSchema, {}),
    });
    await expect(
      odd.setLotLayout(admin, { auctionId, layout, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    const missing = adapter({
      setLotLayout: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    await expect(
      missing.setLotLayout(admin, { auctionId, layout, opId }),
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
    ).resolves.toMatchObject({ kind: "invalid" });
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

  it("marks the floor and the proxy bids of the latest bids", async () => {
    const bid = (
      rubles: number,
      origin:
        | { case: "manual"; value: { source: BidSource } }
        | { case: "proxy"; value: Record<string, never> },
    ) => ({
      sequence: BigInt(rubles),
      occurredAt: "2026-10-27T18:00:00Z",
      kind: {
        case: "bid" as const,
        value: {
          bidId: lotId,
          participantId: "a",
          amount: rub(rubles),
          origin,
        },
      },
    });
    const read = adapter({
      listLotHistory: async () =>
        create(ListLotHistoryResponseSchema, {
          entries: [
            bid(100, { case: "manual", value: { source: BidSource.BOT } }),
            bid(200, { case: "manual", value: { source: BidSource.FLOOR } }),
            bid(300, { case: "proxy", value: {} }),
          ],
          nextPageToken: "",
        }),
      getDisplayNames: async () => ({ names: {} }),
    });

    const found = await read.recentBids(admin, {
      auctionId,
      lotId,
      limit: 3,
      extraIds: [],
    });

    expect(found).toMatchObject({
      kind: "ok",
      bids: [
        { origin: "proxy" },
        { origin: "floor" },
        expect.not.objectContaining({ origin: expect.anything() }),
      ],
    });
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
describe("lot info reader", () => {
  const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
  const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

  it("reads the title as the recipient with the right to bid", async () => {
    const getLot = vi.fn().mockResolvedValue({ card: { title: "Кружка" } });
    await expect(
      createLotInfoReader({ getLot, getAuction: vi.fn() }).lotInfo(
        identityId,
        lotId,
      ),
    ).resolves.toEqual({ title: "Кружка" });
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

  // Дедлайн и число продлений анти-снайпом несёт лот в торгах: без них текст
  // остаётся без времени.
  it("reads the deadline of a lot in trading", async () => {
    const getLot = vi.fn().mockResolvedValue({
      card: { title: "Кружка" },
      status: {
        case: "trading",
        value: { deadline: "2026-10-20T19:45:00Z", extensionsUsed: 2 },
      },
    });
    await expect(
      createLotInfoReader({ getLot, getAuction: vi.fn() }).lotInfo(
        identityId,
        lotId,
      ),
    ).resolves.toEqual({
      title: "Кружка",
      deadline: "2026-10-20T19:45:00Z",
      extensionsUsed: 2,
    });
  });

  // Ориентировочное время финала для вести о конце торгов (PER-812): читается
  // от имени получателя с правом ставок.
  it("reads the estimated final time of an auction as the recipient", async () => {
    const getAuction = vi.fn().mockResolvedValue({
      auction: create(AuctionSnapshotSchema, {
        id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1",
        status: {
          case: "onBreak",
          value: create(AuctionState_BreakSchema, {}),
        },
        finalAt: "2026-10-31T17:00:00Z",
      }),
    });
    await expect(
      createLotInfoReader({ getLot: vi.fn(), getAuction }).auctionFinalAt(
        identityId,
        "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1",
      ),
    ).resolves.toBe("2026-10-31T17:00:00Z");
    expect(getAuction).toHaveBeenCalledWith(
      {
        viewer: expect.objectContaining({
          identityId,
          rights: [AccessRight.PLACE_BIDS],
        }),
        auctionId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1",
      },
      expect.anything(),
    );
  });

  it("gives an empty title to a lot without a card", async () => {
    const getLot = vi.fn().mockResolvedValue({});
    await expect(
      createLotInfoReader({ getLot, getAuction: vi.fn() }).lotInfo(
        identityId,
        lotId,
      ),
    ).resolves.toEqual({ title: "" });
  });
});

// «Ставки зала» (PER-565, ADR-070): имена аукциона и ставка `source = FLOOR`
// за человека зала. Отказ — значение ответа, повтора нет.
describe("floor bids adapter", () => {
  const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
  const participantId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
  const amount = { minorUnits: 130_000, currency: "RUB" };
  const refused = (reason: unknown) =>
    adapter({
      placeBid: async () =>
        create(PlaceBidResponseSchema, {
          outcome: { case: "refused", value: { reason: reason as never } },
        }),
    });

  it("places the bid from the room for the named participant", async () => {
    const sent: unknown[] = [];
    const floor = adapter({
      placeBid: async (request: unknown) => {
        sent.push(request);
        return create(PlaceBidResponseSchema, {
          outcome: {
            case: "accepted",
            value: { bidId: opId, lotVersion: 7n },
          },
        });
      },
    });

    await expect(
      floor.placeFloorBid(admin, { lotId, participantId, amount, opId }),
    ).resolves.toEqual({ kind: "accepted", lotVersion: 7 });
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        lotId,
        opId,
        source: BidSource.FLOOR,
        participantId,
        amount: { minorUnits: 130_000n, currency: "RUB" },
      }),
    ]);
  });

  it("reads every floor refusal as a value", async () => {
    const cases: [unknown, unknown][] = [
      [
        {
          case: "bidNotAtNextPrice",
          value: { expected: { minorUnits: 140_000n, currency: "RUB" } },
        },
        {
          kind: "bid-not-at-next-price",
          expected: { ...amount, minorUnits: 140_000 },
        },
      ],
      [
        { case: "bidderIsLeader", value: { currentPrice: amount } },
        { kind: "bidder-is-leader" },
      ],
      [{ case: "lotNotOpen", value: {} }, { kind: "lot-not-open" }],
      [
        { case: "displayNameNotChosen", value: {} },
        { kind: "display-name-not-chosen" },
      ],
      [
        { case: "participantCannotBid", value: {} },
        { kind: "participant-cannot-bid" },
      ],
      [
        { case: "participantRemovedFromLot", value: {} },
        { kind: "removed-from-lot" },
      ],
      [
        { case: "notMeetupAdministrator", value: {} },
        { kind: "not-administrator" },
      ],
      [{ case: "meetupNotFound", value: {} }, { kind: "meetup-not-found" }],
    ];
    for (const [reason, outcome] of cases) {
      await expect(
        refused(reason).placeFloorBid(admin, {
          lotId,
          participantId,
          amount,
          opId,
        }),
      ).resolves.toEqual(outcome);
    }
    await expect(
      refused({ case: "currencyMismatch", value: {} }).placeFloorBid(admin, {
        lotId,
        participantId,
        amount,
        opId,
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("does not repeat a floor bid that got no answer", async () => {
    const placeBid = vi.fn(() =>
      Promise.reject(new ConnectError("deadline", Code.DeadlineExceeded)),
    );
    await expect(
      adapter({ placeBid }).placeFloorBid(admin, {
        lotId,
        participantId,
        amount,
        opId,
      }),
    ).resolves.toMatchObject({ kind: "timeout" });
    expect(placeBid).toHaveBeenCalledTimes(1);
  });

  it("reads the names of the auction", async () => {
    const floor = adapter({
      listAuctionNames: async () =>
        create(ListAuctionNamesResponseSchema, {
          names: [{ participantId, name: { text: "Аня" } }],
        }),
    });
    await expect(floor.listAuctionNames(admin, auctionId)).resolves.toEqual({
      kind: "ok",
      names: [{ participantId, name: "Аня" }],
    });
  });
});

// Снятие участника с лота (PER-659, ADR-072): участники по хронологии,
// предпросмотр и снятие на его номере; отказы — значения.
describe("participant removal adapter", () => {
  const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
  const money = (rubles: number) => ({
    minorUnits: BigInt(rubles * 100),
    currency: "RUB",
  });
  const bid = (sequence: number, participantId: string, removed = false) => ({
    sequence: BigInt(sequence),
    occurredAt: "2026-10-27T18:00:00Z",
    kind: {
      case: "bid" as const,
      value: {
        bidId: lotId,
        participantId,
        amount: money(sequence * 100),
        origin: { case: "proxy" as const, value: {} },
        removed,
      },
    },
  });

  it("lists the participants of the lot in the order of their first bid with their names", async () => {
    const pages: Record<string, unknown> = {
      "": create(ListLotHistoryResponseSchema, {
        entries: [bid(1, "b", true), bid(2, "a"), bid(3, "b", true)],
        nextPageToken: "next",
      }),
      next: create(ListLotHistoryResponseSchema, {
        entries: [
          {
            sequence: 4n,
            occurredAt: "2026-10-27T18:01:00Z",
            kind: { case: "removal", value: { price: money(200) } },
          },
          bid(5, "c"),
        ],
        nextPageToken: "",
      }),
    };
    const asked: unknown[] = [];
    const read = adapter({
      listLotHistory: async (request) =>
        pages[(request as { pageToken: string }).pageToken],
      getDisplayNames: async (request) => {
        asked.push(request);
        return { names: { a: { text: "Аня" }, b: { text: "Боря" } } };
      },
    });
    await expect(
      read.lotParticipants(admin, { auctionId, lotId }),
    ).resolves.toEqual({
      kind: "ok",
      participants: [
        { participantId: "b", name: "Боря", removed: true },
        { participantId: "a", name: "Аня", removed: false },
        { participantId: "c", removed: false },
      ],
    });
    expect(asked).toMatchObject([
      { auctionId, participantIds: ["b", "a", "c"] },
    ]);
  });

  it("refuses a history it could not read to the end", async () => {
    const endless = adapter({
      listLotHistory: async () =>
        create(ListLotHistoryResponseSchema, {
          entries: [bid(1, "a")],
          nextPageToken: "more",
        }),
    });
    await expect(
      endless.lotParticipants(admin, { auctionId, lotId }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("previews the removal and sends the version it decided at back with the removal", async () => {
    const sent: unknown[] = [];
    const removal = adapter({
      previewParticipantRemoval: async (request) => {
        sent.push(request);
        return {
          outcome: {
            case: "preview",
            value: {
              price: money(1_200),
              leaderId: "b",
              extendedDeadline: "2026-10-27T18:10:00Z",
              version: 7n,
            },
          },
        };
      },
      removeParticipant: async (request) => {
        sent.push(request);
        return { outcome: { case: "accepted", value: { lotVersion: 8n } } };
      },
    });
    const target = { auctionId, lotId, participantId: "a" };
    await expect(
      removal.previewParticipantRemoval(admin, target),
    ).resolves.toEqual({
      kind: "ok",
      preview: {
        price: { minorUnits: 120_000, currency: "RUB" },
        leaderId: "b",
        extendedDeadline: "2026-10-27T18:10:00Z",
        version: 7,
      },
    });
    await expect(
      removal.removeParticipant(admin, {
        ...target,
        expectedVersion: 7,
        opId: "op-1",
      }),
    ).resolves.toEqual({ kind: "ok", lotVersion: 8 });
    expect(sent).toEqual([
      expect.objectContaining({ viewer: wireAdmin, ...target }),
      expect.objectContaining({
        viewer: wireAdmin,
        ...target,
        expectedVersion: 7n,
        opId: "op-1",
      }),
    ]);
  });

  it("reads every removal refusal as a value", async () => {
    const cases: [string, unknown][] = [
      ["notMeetupAdministrator", { kind: "not-administrator" }],
      ["meetupNotFound", { kind: "meetup-not-found" }],
      ["meetupCancelled", { kind: "meetup-cancelled" }],
      ["lotNotInAuction", { kind: "refused", reason: "lot-not-in-auction" }],
      ["notInPrebidding", { kind: "refused", reason: "not-in-prebidding" }],
      ["lineupFrozen", { kind: "refused", reason: "lineup-frozen" }],
      ["lotNotOpen", { kind: "refused", reason: "lot-not-open" }],
      ["notInOnlinePhase", { kind: "refused", reason: "not-in-online-phase" }],
      ["deadlinePassed", { kind: "refused", reason: "deadline-passed" }],
      [
        "notALotParticipant",
        { kind: "refused", reason: "not-a-lot-participant" },
      ],
      [
        "participantAlreadyRemoved",
        { kind: "refused", reason: "already-removed" },
      ],
      ["lotChanged", { kind: "lot-changed" }],
    ];
    for (const [reason, outcome] of cases) {
      const removal = adapter({
        removeParticipant: async () => ({
          outcome: {
            case: "refused",
            value: { reason: { case: reason, value: {} } },
          },
        }),
      });
      await expect(
        removal.removeParticipant(admin, {
          auctionId,
          lotId,
          participantId: "a",
          expectedVersion: 7,
          opId: "op-1",
        }),
      ).resolves.toEqual(outcome);
    }
  });

  it("takes a preview refused with a changed lot for a defect of Auction", async () => {
    const removal = adapter({
      previewParticipantRemoval: async () => ({
        outcome: {
          case: "refused",
          value: { reason: { case: "lotChanged", value: {} } },
        },
      }),
    });
    await expect(
      removal.previewParticipantRemoval(admin, {
        auctionId,
        lotId,
        participantId: "a",
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("does not repeat a removal that got no answer", async () => {
    const removeParticipant = vi.fn(() =>
      Promise.reject(new ConnectError("deadline", Code.DeadlineExceeded)),
    );
    await expect(
      adapter({ removeParticipant }).removeParticipant(admin, {
        auctionId,
        lotId,
        participantId: "a",
        expectedVersion: 7,
        opId: "op-1",
      }),
    ).resolves.toMatchObject({ kind: "timeout" });
    expect(removeParticipant).toHaveBeenCalledTimes(1);
  });
});

// Счета аукциона (PER-321): сводка организатора и отметки; отказы — значения,
// а выдача и оплата — разные методы Auction.
describe("auction invoices adapter", () => {
  const invoiceId = "5b0d3c1e-8a2f-5c4d-9e6f-1a2b3c4d5e6f";
  const snapshot = (status: "awaitingPayment" | "paid" | "handedOver") => ({
    id: invoiceId,
    auctionId,
    lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
    winnerId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
    amount: { minorUnits: 150_000n, currency: "RUB" },
    paymentDueAt: "2026-10-30T12:00:00Z",
    fulfillment: FulfillmentMethod.PICKUP,
    status: { case: status, value: {} },
  });

  it("reads every invoice of the auction with its status", async () => {
    const sent: unknown[] = [];
    const invoices = adapter({
      listAuctionInvoices: async (request) => {
        sent.push(request);
        return {
          outcome: {
            case: "invoices",
            value: {
              invoices: [snapshot("awaitingPayment"), snapshot("handedOver")],
            },
          },
        };
      },
    });
    await expect(
      invoices.listAuctionInvoices(admin, auctionId),
    ).resolves.toEqual({
      kind: "ok",
      invoices: [
        expect.objectContaining({
          invoiceId,
          amount: { minorUnits: 150_000, currency: "RUB" },
          paymentDueAt: "2026-10-30T12:00:00Z",
          status: "awaiting-payment",
        }),
        expect.objectContaining({
          status: "handed-over",
        }),
      ],
    });
    expect(sent).toEqual([
      expect.objectContaining({ viewer: wireAdmin, auctionId }),
    ]);
  });

  it("reads the refusals of the invoices as values and a missing auction as such", async () => {
    const refused = (reason: string) =>
      adapter({
        listAuctionInvoices: async () => ({
          outcome: {
            case: "refused",
            value: { reason: { case: reason, value: {} } },
          },
        }),
      }).listAuctionInvoices(admin, auctionId);
    await expect(refused("notMeetupAdministrator")).resolves.toEqual({
      kind: "not-administrator",
    });
    await expect(refused("meetupNotFound")).resolves.toEqual({
      kind: "meetup-not-found",
    });
    await expect(
      adapter({
        listAuctionInvoices: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).listAuctionInvoices(admin, auctionId),
    ).resolves.toEqual({ kind: "auction-not-found" });
  });

  it("refuses an invoice without an amount or a readable due moment as a defect of the neighbour", async () => {
    const { amount: _, ...withoutAmount } = snapshot("paid");
    const read = (invoice: unknown) =>
      adapter({
        listAuctionInvoices: async () => ({
          outcome: { case: "invoices", value: { invoices: [invoice] } },
        }),
      }).listAuctionInvoices(admin, auctionId);
    await expect(read(withoutAmount)).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(
      read({ ...snapshot("paid"), paymentDueAt: "" }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("marks the payment and the handover by their own methods", async () => {
    const paid: unknown[] = [];
    const handedOver: unknown[] = [];
    const marks = adapter({
      markInvoicePaid: async (request) => {
        paid.push(request);
        return { outcome: { case: "accepted", value: {} } };
      },
      markInvoiceHandedOver: async (request) => {
        handedOver.push(request);
        return {
          outcome: {
            case: "refused",
            value: { reason: { case: "invoiceNotPaid", value: {} } },
          },
        };
      },
    });
    await expect(
      marks.markInvoice(admin, { invoiceId, mark: "paid", opId }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      marks.markInvoice(admin, { invoiceId, mark: "handed-over", opId }),
    ).resolves.toEqual({ kind: "invoice-not-paid" });
    expect(paid).toEqual([
      expect.objectContaining({ viewer: wireAdmin, invoiceId, opId }),
    ]);
    expect(handedOver).toEqual([
      expect.objectContaining({ viewer: wireAdmin, invoiceId, opId }),
    ]);
  });

  // Текст «Как оплатить и получить» (PER-322): чтение сводки несёт текст,
  // команда задаёт и снимает его, отказы — значения ответа.
  it("reads the payment text with the invoices", async () => {
    await expect(
      adapter({
        listAuctionInvoices: async () => ({
          outcome: {
            case: "invoices",
            value: { invoices: [], paymentInstructions: "Перевод на карту." },
          },
        }),
      }).listAuctionInvoices(admin, auctionId),
    ).resolves.toEqual({
      kind: "ok",
      invoices: [],
      paymentInstructions: "Перевод на карту.",
    });
  });

  it("sets and takes back the payment text and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      setPaymentInstructions: async (request: unknown) => {
        sent.push(request);
        return { outcome: { case: "accepted", value: {} } };
      },
    });
    await expect(
      accepted.setPaymentInstructions(admin, {
        auctionId,
        opId,
        text: "Перевод на карту.\nЗабрать в зале.",
      }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      accepted.setPaymentInstructions(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        auctionId,
        opId,
        text: "Перевод на карту.\nЗабрать в зале.",
      }),
      expect.not.objectContaining({ text: expect.anything() }),
    ]);

    const reasons = [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
    ] as const;
    for (const [reason, kind] of reasons) {
      await expect(
        adapter({
          setPaymentInstructions: async () => ({
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
        }).setPaymentInstructions(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }

    await expect(
      adapter({
        setPaymentInstructions: async () => ({ outcome: { case: undefined } }),
      }).setPaymentInstructions(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        setPaymentInstructions: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).setPaymentInstructions(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
    await expect(
      adapter({
        setPaymentInstructions: () =>
          Promise.reject(new ConnectError("blank", Code.InvalidArgument)),
      }).setPaymentInstructions(admin, { auctionId, opId, text: " " }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        setPaymentInstructions: () =>
          Promise.reject(new ConnectError("meetups", Code.Unavailable)),
      }).setPaymentInstructions(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("sets and takes back the promo video and reads every refusal as an answer", async () => {
    const sent: unknown[] = [];
    const accepted = adapter({
      setPromoVideo: async (request: unknown) => {
        sent.push(request);
        return { outcome: { case: "accepted", value: {} } };
      },
    });
    await expect(
      accepted.setPromoVideo(admin, { auctionId, opId, postId: 42 }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      accepted.setPromoVideo(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "ok" });
    expect(sent).toEqual([
      expect.objectContaining({
        viewer: wireAdmin,
        auctionId,
        opId,
        video: expect.objectContaining({ messageId: 42n }),
      }),
      expect.not.objectContaining({ video: expect.anything() }),
    ]);

    const reasons = [
      ["notMeetupAdministrator", "not-administrator"],
      ["meetupNotFound", "meetup-not-found"],
      ["meetupCancelled", "meetup-cancelled"],
    ] as const;
    for (const [reason, kind] of reasons) {
      await expect(
        adapter({
          setPromoVideo: async () => ({
            outcome: {
              case: "refused",
              value: { reason: { case: reason, value: {} } },
            },
          }),
        }).setPromoVideo(admin, { auctionId, opId }),
      ).resolves.toEqual({ kind });
    }

    await expect(
      adapter({
        setPromoVideo: async () => ({ outcome: { case: undefined } }),
      }).setPromoVideo(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      adapter({
        setPromoVideo: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).setPromoVideo(admin, { auctionId, opId }),
    ).resolves.toEqual({ kind: "auction-not-found" });
    await expect(
      adapter({
        setPromoVideo: () =>
          Promise.reject(new ConnectError("meetups", Code.Unavailable)),
      }).setPromoVideo(admin, { auctionId, opId, postId: 7 }),
    ).resolves.toMatchObject({ kind: "unavailable" });

    // Тот же ключ прикрепления с другим постом — повтор ответа после рестарта
    // (PER-793): видео уже прикреплено. У снятия ключ рождается на нажатие,
    // и занятый ключ остаётся отказом.
    const taken = adapter({
      setPromoVideo: () =>
        Promise.reject(new ConnectError("op id taken", Code.AlreadyExists)),
    });
    await expect(
      taken.setPromoVideo(admin, { auctionId, opId, postId: 8 }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      taken.setPromoVideo(admin, { auctionId, opId }),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it("reads a missing invoice and an unanswered mark without a repeat", async () => {
    await expect(
      adapter({
        markInvoicePaid: () =>
          Promise.reject(new ConnectError("no", Code.NotFound)),
      }).markInvoice(admin, { invoiceId, mark: "paid", opId }),
    ).resolves.toEqual({ kind: "invoice-not-found" });
    const markInvoicePaid = vi.fn(() =>
      Promise.reject(new ConnectError("deadline", Code.DeadlineExceeded)),
    );
    await expect(
      adapter({ markInvoicePaid }).markInvoice(admin, {
        invoiceId,
        mark: "paid",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "timeout" });
    expect(markInvoicePaid).toHaveBeenCalledTimes(1);
  });
});
