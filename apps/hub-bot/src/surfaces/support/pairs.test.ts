import { describe, expect, it } from "vitest";
import { createMemoryKv } from "../../../testkit/support.js";
import { createPairStore, supportTopicsBucket } from "./pairs.js";

const group = -1001234567890;

describe("support pair store", () => {
  it("names the bucket after the service", () => {
    expect(supportTopicsBucket("support-bot")).toBe("support-bot-topics");
  });

  it("binds both ways, the topic first", async () => {
    const kv = createMemoryKv();
    const pairs = createPairStore(kv, group);
    await pairs.bind(7001, 12);
    expect(kv.ops).toEqual([
      `put topic.${group}.12`,
      `put person.${group}.7001`,
    ]);
    await expect(pairs.threadOf(7001)).resolves.toBe(12);
    await expect(pairs.personOf(12)).resolves.toBe(7001);
  });

  it("unbinds the person first", async () => {
    const kv = createMemoryKv();
    const pairs = createPairStore(kv, group);
    await pairs.bind(7001, 12);
    kv.ops.length = 0;
    await pairs.unbind(7001, 12);
    expect(kv.ops).toEqual([
      `delete person.${group}.7001`,
      `delete topic.${group}.12`,
    ]);
    await expect(pairs.threadOf(7001)).resolves.toBeUndefined();
    await expect(pairs.personOf(12)).resolves.toBeUndefined();
  });

  // Bucket — общее хранилище: запись не той формы — отсутствие, а не ответ
  // не тому человеку.
  it.each(["", "abc", "-5", "0", "1.5", "99999999999999999999"])(
    "reads %j as no pair",
    async (value) => {
      const kv = createMemoryKv();
      kv.values.set(`person.${group}.7001`, value);
      await expect(createPairStore(kv, group).threadOf(7001)).resolves.toBe(
        undefined,
      );
    },
  );

  it("keeps groups apart", async () => {
    const kv = createMemoryKv();
    await createPairStore(kv, -1009999999999).bind(7001, 12);
    await expect(createPairStore(kv, group).threadOf(7001)).resolves.toBe(
      undefined,
    );
  });
});
