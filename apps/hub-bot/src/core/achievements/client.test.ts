import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  IssueMethod,
  Recipients,
} from "../../../gen/achievements/v1/achievements_pb.js";
import {
  AchievementImageSchema,
  EventAchievementsSchema,
  MyAchievementsSchema,
} from "../../../gen/achievements/v1/achievements_service_pb.js";
import { type AchievementsRpc, achievementsPort } from "./client.js";

const id = "01929b7e-5c1d-7a3f-8e4b-000000000001";
const auctionId = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const known = {
  recipients: Recipients.MANY,
  issueMethod: IssueMethod.RULE,
};
function rpc(): AchievementsRpc {
  return {
    listMyAchievements: vi.fn(async () =>
      create(MyAchievementsSchema, { identityId: id }),
    ),
    getEventAchievements: vi.fn(async () =>
      create(EventAchievementsSchema, {
        event: { kind: { case: "auctionId", value: auctionId } },
      }),
    ),
    getAchievementImage: vi.fn(async () =>
      create(AchievementImageSchema, {
        content: new Uint8Array([1, 2]),
        mediaType: "image/png",
        version: "v2",
      }),
    ),
  };
}

describe("achievements read adapter", () => {
  it("filters meetup grants out of the auction collection and carries request metadata", async () => {
    const client = rpc();
    client.listMyAchievements = vi.fn(async () =>
      create(MyAchievementsSchema, {
        identityId: id,
        achievements: [
          {
            grant: {
              id,
              identityId: id,
              grantedAt: "2026-10-28T12:00:00Z",
              event: { kind: { case: "auctionId", value: auctionId } },
              achievementCode: "first",
            },
            achievement: { code: "first", title: "Первая", ...known },
          },
          {
            grant: {
              id,
              identityId: id,
              event: { kind: { case: "meetupId", value: auctionId } },
            },
            achievement: { code: "meetup", title: "Сходка" },
          },
        ],
      }),
    );
    const rows = await achievementsPort(client, {
      requestId: "request-1",
    }).listMine(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      auctionId,
      achievement: { code: "first" },
    });
    expect(client.listMyAchievements).toHaveBeenCalledWith(
      { identityId: id },
      expect.objectContaining({ headers: { "x-request-id": "request-1" } }),
    );
  });
  it("rejects a collection or grant belonging to somebody else", async () => {
    const client = rpc();
    client.listMyAchievements = vi.fn(async () =>
      create(MyAchievementsSchema, { identityId: "foreign" }),
    );
    await expect(achievementsPort(client).listMine(id)).rejects.toThrow(
      "identity mismatch",
    );
    client.listMyAchievements = vi.fn(async () =>
      create(MyAchievementsSchema, {
        identityId: id,
        achievements: [
          { grant: { identityId: "foreign" }, achievement: { code: "first" } },
        ],
      }),
    );
    await expect(achievementsPort(client).listMine(id)).rejects.toThrow(
      "identity mismatch",
    );
  });
  it("shows an unfixed nonempty set and rejects a response for another event", async () => {
    const client = rpc();
    client.getEventAchievements = vi.fn(async () =>
      create(EventAchievementsSchema, {
        fixed: false,
        event: { kind: { case: "auctionId", value: auctionId } },
        achievements: [
          { achievement: { code: "first", ...known }, erasedHolders: 1 },
        ],
      }),
    );
    expect(await achievementsPort(client).getEvent(auctionId)).toHaveLength(1);
    await expect(achievementsPort(client).getEvent(id)).rejects.toThrow(
      "event mismatch",
    );
  });
  it("rejects a definition with an unspecified or unknown enum", async () => {
    for (const unknown of [
      { recipients: Recipients.UNSPECIFIED, issueMethod: IssueMethod.RULE },
      { recipients: Recipients.MANY, issueMethod: IssueMethod.UNSPECIFIED },
      { recipients: 99 as Recipients, issueMethod: IssueMethod.MANUAL },
    ]) {
      const client = rpc();
      client.getEventAchievements = vi.fn(async () =>
        create(EventAchievementsSchema, {
          fixed: true,
          event: { kind: { case: "auctionId", value: auctionId } },
          achievements: [{ achievement: { code: "first", ...unknown } }],
        }),
      );
      await expect(
        achievementsPort(client).getEvent(auctionId),
      ).rejects.toThrow("unknown enum");
    }
  });
  it("loads image bytes independently of the list", async () => {
    const client = rpc();
    await achievementsPort(client).listMine(id);
    expect(client.getAchievementImage).not.toHaveBeenCalled();
    expect(await achievementsPort(client).getImage("first")).toEqual({
      content: new Uint8Array([1, 2]),
      mediaType: "image/png",
      version: "v2",
    });
  });
});
