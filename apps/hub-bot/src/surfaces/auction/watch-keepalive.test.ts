import { describe, expect, it } from "vitest";
import {
  TEST_KEEPALIVE,
  watchThroughSilence,
} from "../../../testkit/watch-keepalive.js";
import { noopTracing } from "../../core/tracing.js";
import { createClients } from "./clients.js";

// Полуоткрытое соединение с Auction (PER-705) у бота аукциона: карточка
// финала замечает тишину keepalive своего клиента и переподключается.
describe("auction watch of the auction bot over a silent network", () => {
  it("reconnects within the keepalive timeout and marks the stream interrupted", async () => {
    const run = await watchThroughSilence(
      (baseUrl, keepalive) =>
        createClients({
          identityUrl: baseUrl,
          auctionUrl: baseUrl,
          serviceToken: "bot-service-token",
          tracing: noopTracing(),
          auctionKeepalive: keepalive,
        }),
      TEST_KEEPALIVE,
    );
    expect(run.interruptedWithinMs).toBeLessThan(
      (TEST_KEEPALIVE.pingIntervalMs ?? 0) +
        (TEST_KEEPALIVE.pingTimeoutMs ?? 0) +
        1_000,
    );
    expect(run.recovered).toBe(true);
  });
});
