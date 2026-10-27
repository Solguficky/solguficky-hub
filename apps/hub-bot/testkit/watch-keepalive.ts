import type { Http2SessionOptions } from "@connectrpc/connect-node";
import { expect } from "vitest";
import {
  type AuctionWatchSource,
  createAuctionWatches,
} from "../src/core/auction/watch.js";
import { openStallingProxy } from "./stalling-proxy.js";
import { openWatchServer } from "./watch-server.js";

// Сценарий keepalive потока `WatchAuction` (PER-705), общий у клиентов обеих
// поверхностей: поток идёт через прокси, сеть которого замолкает, а не
// закрывается. Клиент с keepalive замечает тишину за `pingIntervalMs +
// pingTimeoutMs`, помечает подписчику обрыв и переподключается, а после
// возврата сети поток снова отдаёт состояние.

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";

// Сжатый keepalive теста: секунды настоящего сжаты до долей.
export const TEST_KEEPALIVE: Http2SessionOptions = {
  pingIntervalMs: 200,
  pingTimeoutMs: 200,
};

export type WatchClient = { watch: AuctionWatchSource; close(): void };

const until = async (condition: () => boolean, withinMs: number) => {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

export async function watchThroughSilence(
  clientOf: (baseUrl: string, keepalive: Http2SessionOptions) => WatchClient,
  keepalive: Http2SessionOptions,
): Promise<{ interruptedWithinMs?: number; recovered: boolean }> {
  const server = await openWatchServer(AUCTION_ID);
  const proxy = await openStallingProxy(server.port);
  const client = clientOf(`http://127.0.0.1:${proxy.port}`, keepalive);
  const watches = createAuctionWatches({
    source: client.watch,
    retryDelaysMs: [50],
  });
  let states = 0;
  let interrupted = 0;
  try {
    watches.subscribe(
      AUCTION_ID,
      { identityId: "alice", rights: ["place-bids"] },
      () => {
        states += 1;
      },
      undefined,
      () => {
        interrupted += 1;
      },
    );
    expect(await until(() => states === 1, 5_000)).toBe(true);
    proxy.silence();
    const silencedAt = Date.now();
    const budget =
      (keepalive.pingIntervalMs ?? 0) + (keepalive.pingTimeoutMs ?? 0) + 1_000;
    // Обрыв заметен по пометке подписчику и по новой попытке клиента.
    const noticed = await until(
      () => interrupted > 0 && proxy.connections() > 1,
      budget,
    );
    const interruptedWithinMs = noticed ? Date.now() - silencedAt : undefined;
    proxy.restore();
    const recovered =
      noticed &&
      (await until(() => states >= 2 && server.opened() >= 2, 5_000));
    return {
      ...(interruptedWithinMs === undefined ? {} : { interruptedWithinMs }),
      recovered,
    };
  } finally {
    watches.close();
    client.close();
    await proxy.close();
    await server.close();
  }
}
