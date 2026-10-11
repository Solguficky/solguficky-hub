import { describe, expect, it } from "vitest";
import { CONTRACT_LOT } from "../../auction-ui/contract/index.js";
import type { LotView } from "../../auction-ui/index.js";
import { FRESH_READ_PAUSES_MS, readLotAtLeast } from "./fresh.js";

const at = (version: number): LotView => ({ ...CONTRACT_LOT, version });

// Read model, которая отдаёт версии по очереди, и пауза без часов: тест видит,
// сколько чтений и пауз сделал помощник.
function lagging(...answers: (number | Error)[]) {
  const reads: number[] = [];
  const pauses: number[] = [];
  return {
    reads,
    pauses,
    read: async () => {
      const answer = answers[reads.length];
      reads.push(reads.length);
      if (answer === undefined) throw new Error("read is not expected");
      if (answer instanceof Error) throw answer;
      return at(answer);
    },
    pause: async (ms: number) => {
      pauses.push(ms);
    },
  };
}

describe("readLotAtLeast", () => {
  it("reads once without a version", async () => {
    const model = lagging(3);
    expect(
      (await readLotAtLeast(model.read, undefined, model.pause)).version,
    ).toBe(3);
    expect(model.pauses).toEqual([]);
  });

  it("reads once when the first read already shows the command", async () => {
    const model = lagging(5);
    expect((await readLotAtLeast(model.read, 4, model.pause)).version).toBe(5);
    expect(model.reads).toHaveLength(1);
  });

  it("rereads with pauses until the read model catches up", async () => {
    const model = lagging(3, 3, 4);
    expect((await readLotAtLeast(model.read, 4, model.pause)).version).toBe(4);
    expect(model.pauses).toEqual(FRESH_READ_PAUSES_MS.slice(0, 2));
  });

  // Не догнал — последняя карточка, а не отказ: команда уже принята.
  it("gives the last read when the read model does not catch up in time", async () => {
    const model = lagging(3, 3, 3, 3, 3);
    expect((await readLotAtLeast(model.read, 4, model.pause)).version).toBe(3);
    expect(model.pauses).toEqual(FRESH_READ_PAUSES_MS);
    expect(model.reads).toHaveLength(FRESH_READ_PAUSES_MS.length + 1);
  });

  it("gives the last read when a reread fails, the exhausted budget included", async () => {
    const model = lagging(3, new Error("deadline exceeded"));
    expect((await readLotAtLeast(model.read, 4, model.pause)).version).toBe(3);
  });

  it("throws when the first read fails", async () => {
    const model = lagging(new Error("unavailable"));
    await expect(readLotAtLeast(model.read, 4, model.pause)).rejects.toThrow(
      "unavailable",
    );
  });
});
