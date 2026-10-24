import { describe, expect, it } from "vitest";
import {
  TEST_KEEPALIVE,
  watchThroughSilence,
} from "../../../../testkit/watch-keepalive.js";
import { noopTracing } from "../../../core/tracing.js";
import { createAuctionClient } from "./client.js";

// Полуоткрытое соединение с Auction (PER-705): сеть замолкла, а не закрылась.
// Поток хаба — живые карточки финала, пульт ведущего и «Ставки зала» —
// замечает тишину своим keepalive и переподключается с пометкой обрыва.
const client = (baseUrl: string, keepalive: typeof TEST_KEEPALIVE) =>
  createAuctionClient(baseUrl, {
    tracing: noopTracing(),
    serviceToken: "bot-service-token",
    keepalive,
  });

describe("auction watch of the hub over a silent network", () => {
  it("reconnects within the keepalive timeout and marks the stream interrupted", async () => {
    const run = await watchThroughSilence(client, TEST_KEEPALIVE);
    expect(run.interruptedWithinMs).toBeLessThan(
      (TEST_KEEPALIVE.pingIntervalMs ?? 0) +
        (TEST_KEEPALIVE.pingTimeoutMs ?? 0) +
        1_000,
    );
    expect(run.recovered).toBe(true);
  });

  // Без keepalive тот же прокси обрыва не даёт: сеть именно молчит.
  it("stays on the silent stream without keepalive", async () => {
    const run = await watchThroughSilence(client, {});
    expect(run.interruptedWithinMs).toBeUndefined();
  });
});
