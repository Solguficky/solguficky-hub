import http2 from "node:http2";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { MeetupVisibility } from "../gen/meetups/v1/meetups_pb.js";
import { MeetupsService } from "../gen/meetups/v1/meetups_service_pb.js";
import { openDirectClients } from "./contour.js";

const botServiceToken = "contour-bot-token";
const maintainerToken = "contour-maintainer-token";
const author = "author";
const snapshots = [
  { id: "z-draft", author, version: 1n, visibility: MeetupVisibility.HIDDEN },
  { id: "a-archived", author, version: 4n },
  { id: "foreign", author: "another-author", version: 100n },
];
const viewers: { identityId: string; globalRoles: number[] }[] = [];
let server: http2.Http2Server;
let direct: ReturnType<typeof openDirectClients>;

function requireToken(context: HandlerContext, token: string): void {
  if (context.requestHeader.get("authorization") !== `Bearer ${token}`) {
    throw new ConnectError("unexpected caller", Code.Unauthenticated);
  }
}

function requireBot(context: HandlerContext): void {
  requireToken(context, botServiceToken);
}

const identityId = "0192f8a0-0000-7000-8000-000000000001";

beforeAll(async () => {
  server = http2.createServer(
    connectNodeAdapter({
      routes: (router) => {
        // Identity проверяет вызывающего так же, как Meetups (ADR-056), а
        // maintainer-RPC — своим секретом ADR-037.
        router.service(IdentityService, {
          resolveIdentity(_request, context) {
            requireBot(context);
            return { identityId };
          },
          addAllowedUsername(_request, context) {
            requireBot(context);
            return {};
          },
          grantAdminRole(_request, context) {
            requireToken(context, maintainerToken);
            return { changed: true };
          },
        });
        router.service(MeetupsService, {
          listVisibleMeetups(request, context) {
            requireBot(context);
            if (request.viewer !== undefined) viewers.push(request.viewer);
            return { meetups: [{ id: "z-draft" }, { id: "foreign" }] };
          },
          listArchivedMeetups(request, context) {
            requireBot(context);
            if (request.viewer !== undefined) viewers.push(request.viewer);
            // Дубликат проверяет объединение списков без двойного счёта.
            return { meetups: [{ id: "a-archived" }, { id: "z-draft" }] };
          },
          getMeetup(request, context) {
            requireBot(context);
            if (request.viewer !== undefined) viewers.push(request.viewer);
            const snapshot = snapshots.find((item) => item.id === request.id);
            if (snapshot === undefined) {
              throw new ConnectError("unknown meetup", Code.NotFound);
            }
            return snapshot;
          },
          createMeetupDraft(request, context) {
            requireBot(context);
            return { id: request.id, version: 1n };
          },
          listMeetupStates() {
            throw new ConnectError(
              "closed for all callers",
              Code.Unauthenticated,
            );
          },
        });
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  direct = openDirectClients({
    identityUrl: url,
    meetupsUrl: url,
    maintainerToken,
    botServiceToken,
  });
});

afterAll(async () => {
  direct.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("direct contour clients", () => {
  it("counts own hidden and archived snapshots through authenticated viewer-aware reads", async () => {
    expect(await direct.journalOf(author)).toEqual({
      meetupIds: ["a-archived", "z-draft"],
      events: 5,
    });
    expect(viewers).toHaveLength(5);
    for (const viewer of viewers) {
      expect(viewer).toMatchObject({ identityId: author, globalRoles: [] });
    }
  });

  it("does not count another author's visible meetups", async () => {
    expect(await direct.journalOf("author-without-meetups")).toEqual({
      meetupIds: [],
      events: 0,
    });
  });

  it("presents the bot token to Identity without overriding the maintainer secret", async () => {
    expect(await direct.grantAdmin(42n)).toBe(identityId);
    expect(await direct.identityOf(42n)).toBe(identityId);
    await direct.allowUsername(identityId, "member");
  });

  it("presents the bot token on direct commands too", async () => {
    expect(await direct.createDraftAsAdmin(author, "new-draft")).toEqual({
      id: "new-draft",
      version: 1n,
    });
  });
});
