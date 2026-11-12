import { describe, expect, it } from "vitest";
import { createKvRoom, createMemoryRoom, type RoomKv } from "./floor-room.js";

// KV в памяти с ревизиями: `create` отказывает на существующем ключе, `update`
// — на устаревшей ревизии, как JetStream.
function fakeKv(initial?: string) {
  let value = initial;
  let revision = initial === undefined ? 0 : 1;
  const conflicts = { next: 0 };
  const kv = {
    async get() {
      return value === undefined
        ? null
        : { operation: "PUT", revision, string: () => value as string };
    },
    async create(_key: string, data: string) {
      if (value !== undefined) throw new Error("wrong last sequence: 1");
      value = data;
      revision += 1;
      return revision;
    },
    async update(_key: string, data: string, expected: number) {
      if (conflicts.next > 0) {
        conflicts.next -= 1;
        revision += 1;
        throw new Error("wrong last sequence: 9");
      }
      if (expected !== revision) throw new Error("wrong last sequence: 9");
      value = data;
      revision += 1;
      return revision;
    },
  } as unknown as RoomKv;
  return { kv, conflicts, raw: () => value };
}

describe("floor room in memory", () => {
  it("keeps each auction apart and adds a person once", async () => {
    const room = createMemoryRoom();
    await room.add("a", { identityId: "x", username: "x_x" });
    await room.add("a", { identityId: "x", username: "x_x" });
    await room.add("b", { identityId: "y" });

    expect(await room.read("a")).toEqual({
      kind: "ok",
      members: [{ identityId: "x", username: "x_x" }],
    });
    await room.remove("a", "x");
    expect(await room.read("a")).toEqual({ kind: "ok", members: [] });
  });
});

describe("floor room in the key-value bucket", () => {
  it("creates the record on the first person and updates it on the next", async () => {
    const { kv, raw } = fakeKv();
    const room = createKvRoom(async () => kv);

    expect(await room.add("a", { identityId: "x", username: "x_x" })).toEqual({
      kind: "ok",
    });
    expect(await room.add("a", { identityId: "y" })).toEqual({ kind: "ok" });

    expect(JSON.parse(raw() ?? "[]")).toEqual([
      { i: "x", u: "x_x" },
      { i: "y" },
    ]);
    expect(await room.read("a")).toEqual({
      kind: "ok",
      members: [{ identityId: "x", username: "x_x" }, { identityId: "y" }],
    });
  });

  it("reads again after another helper moved the revision", async () => {
    const { kv, conflicts } = fakeKv(JSON.stringify([{ i: "x" }]));
    const room = createKvRoom(async () => kv);
    conflicts.next = 2;

    expect(await room.add("a", { identityId: "y" })).toEqual({ kind: "ok" });
    const read = await room.read("a");
    expect(read.kind === "ok" && read.members.map((m) => m.identityId)).toEqual(
      ["x", "y"],
    );
  });

  it("reports an unreachable bucket as unavailable, not as an empty room", async () => {
    const room = createKvRoom(async () => {
      throw new Error("no bucket");
    });

    expect((await room.read("a")).kind).toBe("unavailable");
    expect((await room.add("a", { identityId: "x" })).kind).toBe("unavailable");
    expect((await room.remove("a", "x")).kind).toBe("unavailable");
  });

  it("treats a record of the wrong shape as an empty room", async () => {
    const { kv } = fakeKv('{"not":"a list"}');
    const room = createKvRoom(async () => kv);

    expect(await room.read("a")).toEqual({ kind: "ok", members: [] });
    expect(await room.add("a", { identityId: "x" })).toEqual({ kind: "ok" });
  });

  it("stops after the retries when the revision keeps moving", async () => {
    const { kv, conflicts } = fakeKv(JSON.stringify([]));
    const room = createKvRoom(async () => kv);
    conflicts.next = 10;

    expect((await room.add("a", { identityId: "x" })).kind).toBe("unavailable");
  });
});
