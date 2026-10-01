import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { MeetupsService } from "../gen/meetups/v1/meetups_service_pb.js";
import { NotificationsService } from "../gen/notifications/v1/notifications_service_pb.js";
import { createIdentityClient } from "./identity/client.js";
import { createMeetupsClient } from "./meetups/client.js";
import { createNotificationsClient } from "./notifications/client.js";
import { authorizationHeader, requestIdHeader } from "./rpc-metadata.js";
import { noopTracing } from "./tracing.js";

// Токен ставит транспорт фабрики, а не адаптер, поэтому тест идёт через
// настоящий gRPC по HTTP/2 до сервера в этом же процессе: подмена `rpc`, как в
// тестах адаптеров, interceptor фабрики не увидела бы.
const serviceToken = "bot-service-token";

type Seen = { authorization: string | null; requestId: string | null };
const seen = new Map<string, Seen>();

function record(method: string, context: HandlerContext) {
  seen.set(method, {
    authorization: context.requestHeader.get(authorizationHeader),
    requestId: context.requestHeader.get(requestIdHeader),
  });
}

let server: http2.Http2Server;
let baseUrl: string;

beforeAll(async () => {
  server = http2.createServer(
    connectNodeAdapter({
      routes: (router) =>
        router
          .service(IdentityService, {
            resolveIdentity(_request, context) {
              record("identity", context);
              return { identityId: "id-1" };
            },
          })
          .service(MeetupsService, {
            listVisibleMeetups(_request, context) {
              record("meetups", context);
              return {};
            },
          })
          .service(NotificationsService, {
            getGlobalNotificationPreferences(_request, context) {
              record("notifications", context);
              return {};
            },
          }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const options = () => ({ tracing: noopTracing(), serviceToken });
const meta = { requestId: "req-1" };
const presented = {
  authorization: `Bearer ${serviceToken}`,
  requestId: "req-1",
};

describe("identity client", () => {
  it("presents the bot token next to the request id", async () => {
    const identity = createIdentityClient(baseUrl, options());
    try {
      await identity.resolve({ telegramUserId: 1n }, meta);
    } finally {
      identity.close();
    }
    expect(seen.get("identity")).toEqual(presented);
  });
});

describe("meetups client", () => {
  it("presents the bot token next to the request id", async () => {
    const meetups = createMeetupsClient(baseUrl, {
      ...options(),
      communityTimeZone: "Europe/Moscow",
    });
    try {
      await meetups.listVisible({ identityId: "id-1", globalRoles: [] }, meta);
    } finally {
      meetups.close();
    }
    expect(seen.get("meetups")).toEqual(presented);
  });
});

describe("notifications client", () => {
  it("presents the bot token next to the request id", async () => {
    const notifications = createNotificationsClient(baseUrl, options());
    try {
      await notifications.getGlobalPreferences("id-1", meta);
    } finally {
      notifications.close();
    }
    expect(seen.get("notifications")).toEqual(presented);
  });
});
