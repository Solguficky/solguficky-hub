import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AuctionService } from "../gen/auction/v1/auction_service_pb.js";

// Auction с одним потоком `WatchAuction` для проверки keepalive клиента
// (PER-705): каждое открытие потока сразу отдаёт состояние аукциона и дальше
// молчит, пока клиент его не отпустит, — как идущий аукцион между ставками.
export type WatchServer = {
  port: number;
  /** Сколько раз клиент открыл поток. */
  opened(): number;
  close(): Promise<void>;
};

export async function openWatchServer(auctionId: string): Promise<WatchServer> {
  let opened = 0;
  const server = http2.createServer(
    connectNodeAdapter({
      routes: (router) =>
        router.service(AuctionService, {
          async *watchAuction(_request, context) {
            opened += 1;
            yield { auction: { id: auctionId } };
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          },
        }),
    }),
  );
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    opened: () => opened,
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
