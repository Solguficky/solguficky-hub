import { describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../gen/identity/v1/roles_pb.js";
import {
  type AuctionRpc,
  createPorts,
  type IdentityRpc,
  imageTimeoutMs,
  requestIdHeader,
} from "./clients.js";

function rpcs() {
  const identity = {
    resolveIdentity: vi.fn(async () => ({
      identityId: "id-1",
      globalRoles: [
        GlobalRole.PUBLIC,
        GlobalRole.UNSPECIFIED,
        GlobalRole.MEMBER,
      ],
      blocked: false,
    })),
  };
  const snapshot = {
    id: "lot-1",
    auctionId: "auc-1",
    version: 7n,
    status: { case: "unsold", value: 1 },
  };
  const auction = {
    getFaqAcknowledgement: vi.fn(async () => ({ acknowledged: false })),
    acknowledgeFaq: vi.fn(async () => ({ acknowledged: true })),
    getLot: vi.fn(async () => snapshot),
    listAuctionLots: vi.fn(async () => ({
      lots: [snapshot],
      nextPageToken: "next",
    })),
    getDisplayNames: vi.fn(async () => ({
      names: { "p-1": { text: "@owl", kind: 1 } },
    })),
    getLotImage: vi.fn(async () => ({
      content: new Uint8Array([9]),
      mediaType: "image/jpeg",
      version: "v2",
    })),
  };
  const refused = vi.fn();
  return {
    identity,
    auction,
    refused,
    // Моки отвечают формой сгенерированных сообщений без их классов: это
    // единственное ослабление типа в тесте.
    ports: createPorts(
      identity as unknown as IdentityRpc,
      auction as unknown as AuctionRpc,
      { timeoutMs: 1_000, onNamesRefused: refused },
    )("req-1"),
  };
}

const viewer = { identityId: "id-1", globalRoles: ["public"] as const };
const wireViewer = { identityId: "id-1", globalRoles: [GlobalRole.PUBLIC] };
const callOptions = {
  timeoutMs: 1_000,
  headers: { [requestIdHeader]: "req-1" },
};

describe("createPorts", () => {
  it("does not treat an unconfirmed RPC response as saved completion", async () => {
    const { auction, ports } = rpcs();
    auction.acknowledgeFaq.mockResolvedValue({ acknowledged: false });
    await expect(
      ports.faq.acknowledge({ identityId: "id-1", globalRoles: ["public"] }),
    ).rejects.toThrow("did not acknowledge");
  });
  it("reads and records FAQ acknowledgement for the viewer with request metadata", async () => {
    const { auction, ports } = rpcs();
    const viewer = { identityId: "id-1", globalRoles: ["public"] as const };
    expect(await ports.faq.acknowledged(viewer)).toBe(false);
    await ports.faq.acknowledge(viewer);
    for (const rpc of [auction.getFaqAcknowledgement, auction.acknowledgeFaq]) {
      expect(rpc).toHaveBeenCalledWith(
        { viewer: { identityId: "id-1", globalRoles: [GlobalRole.PUBLIC] } },
        { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
      );
    }
  });
  it("maps the resolved identity and drops the unspecified role", async () => {
    const { identity, ports } = rpcs();
    const resolved = await ports.identity.resolveIdentity({
      telegramUserId: 42,
      telegramUsername: "nick",
    });
    expect(resolved).toEqual({
      identityId: "id-1",
      globalRoles: ["public", "member"],
      blocked: false,
    });
    expect(identity.resolveIdentity).toHaveBeenCalledWith(
      { telegramUserId: 42n, telegramUsername: "nick" },
      { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
    );
  });

  it("sends the viewer to Auction and maps the snapshot", async () => {
    const { auction, ports } = rpcs();
    const lot = await ports.auction.getLot({
      viewer: { identityId: "id-1", globalRoles: ["public"] },
      lotId: "lot-1",
    });
    expect(lot).toEqual({
      lotId: "lot-1",
      auctionId: "auc-1",
      version: 7,
      status: { kind: "unsold" },
    });
    expect(auction.getLot).toHaveBeenCalledWith(
      {
        viewer: { identityId: "id-1", globalRoles: [GlobalRole.PUBLIC] },
        lotId: "lot-1",
      },
      { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
    );
  });

  it("pages the lots of an auction through the same viewer", async () => {
    const { auction, ports } = rpcs();
    const page = await ports.auction.listAuctionLots({
      viewer,
      auctionId: "auc-1",
      pageToken: "t",
    });
    expect(page.nextPageToken).toBe("next");
    expect(page.lots.map((lot) => lot.lotId)).toEqual(["lot-1"]);
    expect(auction.listAuctionLots).toHaveBeenCalledWith(
      { viewer: wireViewer, auctionId: "auc-1", pageToken: "t" },
      callOptions,
    );
  });

  it("returns display names as ready text", async () => {
    const { ports } = rpcs();
    expect(
      await ports.auction.getDisplayNames({
        viewer,
        auctionId: "auc-1",
        participantIds: ["p-1"],
      }),
    ).toEqual({ "p-1": "@owl" });
  });

  // Пакет гасит отказ имён; без сообщения порта деградация была бы немой.
  it("reports a refused display name with the request id before throwing", async () => {
    const { auction, ports, refused } = rpcs();
    const cause = new Error("UNIMPLEMENTED");
    auction.getDisplayNames.mockRejectedValueOnce(cause);
    await expect(
      ports.auction.getDisplayNames({
        viewer,
        auctionId: "auc-1",
        participantIds: ["p-1"],
      }),
    ).rejects.toBe(cause);
    expect(refused).toHaveBeenCalledWith(cause, "req-1");
  });

  it("loads image bytes with the longer image timeout", async () => {
    const { auction, ports } = rpcs();
    const image = await ports.image.getLotImage({ viewer, lotId: "lot-1" });
    expect(image).toEqual({
      content: new Uint8Array([9]),
      mediaType: "image/jpeg",
      version: "v2",
    });
    expect(auction.getLotImage).toHaveBeenCalledWith(
      { viewer: wireViewer, lotId: "lot-1" },
      { timeoutMs: imageTimeoutMs, headers: { [requestIdHeader]: "req-1" } },
    );
  });
});
