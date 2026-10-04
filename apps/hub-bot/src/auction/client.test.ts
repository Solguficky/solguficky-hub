import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionSnapshotSchema,
  DraftAuctionResponseSchema,
  GetMeetupAuctionResponseSchema,
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

function adapter(rpc: {
  draftAuction?: (request: unknown) => Promise<unknown>;
  getMeetupAuction?: (request: unknown) => Promise<unknown>;
}) {
  return createAuctionAdapter({
    draftAuction: (rpc.draftAuction ?? notUsed) as never,
    getMeetupAuction: (rpc.getMeetupAuction ?? notUsed) as never,
    getLot: notUsed,
    listAuctionLots: notUsed,
    getDisplayNames: notUsed,
    getLotImage: notUsed,
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
