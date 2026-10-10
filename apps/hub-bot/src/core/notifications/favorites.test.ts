import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { createFavoritesPort, type FavoritesRpc } from "./favorites.js";

const viewer = { identityId: "id-1", rights: ["place-bids"] as const };
const callOptions = { timeoutMs: 1_000, headers: { "x-request-id": "req-1" } };

function rpcWith(overrides: Partial<Record<keyof FavoritesRpc, unknown>>) {
  // Моки отвечают формой сгенерированных сообщений без их классов: это
  // единственное ослабление типа в тесте.
  return {
    followLot: vi.fn(async () => ({ following: true })),
    unfollowLot: vi.fn(async () => ({ following: false })),
    listFollowedLots: vi.fn(async () => ({ lotIds: ["lot-1", "lot-2"] })),
    ...overrides,
  } as unknown as FavoritesRpc & {
    followLot: ReturnType<typeof vi.fn>;
    unfollowLot: ReturnType<typeof vi.fn>;
    listFollowedLots: ReturnType<typeof vi.fn>;
  };
}

describe("favorites port", () => {
  it("sends the viewer's own identity and the call options", async () => {
    const rpc = rpcWith({});
    const port = createFavoritesPort(rpc, () => callOptions);

    expect(await port.listFollowedLots(viewer)).toEqual(["lot-1", "lot-2"]);
    expect(await port.followLot({ viewer, lotId: "lot-1" })).toEqual({
      kind: "done",
      following: true,
    });
    expect(await port.unfollowLot({ viewer, lotId: "lot-1" })).toEqual({
      kind: "done",
      following: false,
    });
    expect(rpc.listFollowedLots).toHaveBeenCalledWith(
      { identityId: "id-1" },
      callOptions,
    );
    expect(rpc.followLot).toHaveBeenCalledWith(
      { identityId: "id-1", lotId: "lot-1" },
      callOptions,
    );
    expect(rpc.unfollowLot).toHaveBeenCalledWith(
      { identityId: "id-1", lotId: "lot-1" },
      callOptions,
    );
  });

  // Реплика лота в Notifications отстаёт от шины: это «ещё не готово», а не
  // отказ соседа (integration.md, «Избранные лоты»).
  it("reads a lot unknown to Notifications as not ready", async () => {
    const port = createFavoritesPort(
      rpcWith({
        followLot: vi.fn(async () => {
          throw new ConnectError("lot unknown", Code.FailedPrecondition);
        }),
      }),
      () => callOptions,
    );

    expect(await port.followLot({ viewer, lotId: "lot-9" })).toEqual({
      kind: "not-ready",
    });
  });

  it("throws other refusals of a command", async () => {
    const port = createFavoritesPort(
      rpcWith({
        unfollowLot: vi.fn(async () => {
          throw new ConnectError("down", Code.Unavailable);
        }),
      }),
      () => callOptions,
    );

    await expect(
      port.unfollowLot({ viewer, lotId: "lot-1" }),
    ).rejects.toMatchObject({ code: Code.Unavailable });
  });

  // Отказ списка карточка гасит, поэтому порт сообщает о нём до броска.
  it("reports a refused list before throwing it", async () => {
    const refused = vi.fn();
    const cause = new ConnectError("down", Code.Unavailable);
    const port = createFavoritesPort(
      rpcWith({
        listFollowedLots: vi.fn(async () => {
          throw cause;
        }),
      }),
      () => callOptions,
      refused,
    );

    await expect(port.listFollowedLots(viewer)).rejects.toBe(cause);
    expect(refused).toHaveBeenCalledWith(cause);
  });
});
