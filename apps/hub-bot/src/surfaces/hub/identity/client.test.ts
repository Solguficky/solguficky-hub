import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessRight,
  ApplicationQueue,
  Circle,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  AccessRequestOutcome,
  ApplicationCardSchema,
  ApplicationOutcome,
  AppointAdministratorResponseSchema,
  DecideApplicationResponseSchema,
  DismissAdministratorResponseSchema,
  GetCommunityMemberResponseSchema,
  ListAdministratorsResponseSchema,
  ListRefusedApplicationsResponseSchema,
  ReadApplicationQueueResponseSchema,
  RefusedApplicationSchema,
  RequestAccessResponseSchema,
  ResolveIdentityResponseSchema,
} from "../../../../gen/identity/v1/identity_service_pb.js";
import { noopTracing } from "../../../core/tracing.js";
import {
  createAccessRequester,
  createAdministratorManager,
  createApplicationAdministrator,
  createApplicationModerator,
  createAuctionModerationAdministrator,
  createCommunityAdministrator,
  createIdentityClient,
  createIdentityResolver,
  createOrganizerResolver,
  createPlaceBidsReader,
  createTelegramRecipientResolver,
  requestIdHeader,
  useCaseHeader,
} from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function failingResolver(cause: unknown) {
  return createIdentityResolver({
    resolveIdentity: () => Promise.reject(cause),
  });
}

describe("identity client", () => {
  it("returns unavailable when the transport deadline expires", async () => {
    const identity = failingResolver(
      new ConnectError("deadline", Code.DeadlineExceeded),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("does not call identity once the action budget is spent", async () => {
    const resolveIdentity = vi.fn();
    const identity = createIdentityResolver({ resolveIdentity });

    await expect(
      identity.resolve({ telegramUserId: 1n }, { deadlineAt: Date.now() - 1 }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("returns unavailable when identity is down", async () => {
    const identity = failingResolver(
      new ConnectError("connect", Code.Unavailable),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("returns unavailable when the failure is not a connect error", async () => {
    const identity = failingResolver(new Error("socket closed"));
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("returns rejected when identity refuses the request as invalid", async () => {
    const identity = failingResolver(
      new ConnectError(
        "telegram_user_id must be positive",
        Code.InvalidArgument,
      ),
    );
    await expect(
      identity.resolve({ telegramUserId: 0n }),
    ).resolves.toMatchObject({ kind: "rejected", code: "InvalidArgument" });
  });

  it("returns rejected when the contract has drifted", async () => {
    const identity = failingResolver(
      new ConnectError("unknown method", Code.Unimplemented),
    );
    await expect(
      identity.resolve({ telegramUserId: 1n }),
    ).resolves.toMatchObject({ kind: "rejected", code: "Unimplemented" });
  });

  it("passes timeoutMs to the rpc and maps success", async () => {
    let seenTimeout: number | undefined;
    const identity = createIdentityResolver(
      {
        resolveIdentity: async (_request, options) => {
          seenTimeout = options?.timeoutMs;
          return create(ResolveIdentityResponseSchema, {
            identityId: "id-1",
            rights: [AccessRight.ACCESS_HUB, AccessRight.PLACE_BIDS],
          });
        },
      },
      75,
    );
    await expect(
      identity.resolve({ telegramUserId: 1n, telegramUsername: "alice" }),
    ).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      rights: ["access-hub", "place-bids"],
      blocked: false,
    });
    expect(seenTimeout).toBe(75);
  });

  it("resolves an identity without rights to an empty set", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: async () =>
        create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
        }),
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      rights: [],
      blocked: false,
    });
  });

  it("reads the blocked mark separately from the rights", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: async () =>
        create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
          blocked: true,
        }),
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      rights: [],
      blocked: true,
    });
  });

  it("keeps a blocked response with no roles distinct from an ordinary one", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: async () =>
        create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
          blocked: true,
        }),
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      rights: [],
      blocked: true,
    });
  });

  // Поле 2 (снятое `global_roles`) со значением 99 и поле 3 (blocked) = true:
  // сервер может прислать поле, которого этот клиент не знает. Разбор не
  // падает, поле игнорируется, отметка читается отдельно.
  it("parses an unknown field off the wire and ignores it", async () => {
    const response = fromBinary(
      ResolveIdentityResponseSchema,
      Uint8Array.of(0x10, 0x63, 0x18, 0x01),
    );
    const identity = createIdentityResolver({
      resolveIdentity: async () => response,
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "",
      rights: [],
      blocked: true,
    });
  });

  it("carries the request id to identity as a header", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
        });
      },
    });
    await identity.resolve({ telegramUserId: 1n }, { requestId: "req-42" });
    expect(seenHeaders).toEqual({ [requestIdHeader]: "req-42" });
  });

  it("carries use_case next to the request id", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
        });
      },
    });
    await identity.resolve(
      { telegramUserId: 1n },
      { requestId: "req-42", useCase: "view_meetup" },
    );
    expect(seenHeaders).toEqual({
      [requestIdHeader]: "req-42",
      [useCaseHeader]: "view_meetup",
    });
  });

  it("sends no use_case header when the edge produced none", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
        });
      },
    });
    await identity.resolve({ telegramUserId: 1n }, { requestId: "req-42" });
    expect(seenHeaders).toEqual({ [requestIdHeader]: "req-42" });
  });

  it("sends no request id header when the edge produced none", async () => {
    let seenHeaders: Record<string, string> | undefined = { sentinel: "unset" };
    const identity = createIdentityResolver({
      resolveIdentity: async (_request, options) => {
        seenHeaders = options?.headers;
        return create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
        });
      },
    });
    await identity.resolve({ telegramUserId: 1n });
    expect(seenHeaders).toBeUndefined();
  });

  it("closes the http2 session on shutdown", () => {
    const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
    const identity = createIdentityClient("http://127.0.0.1:1", {
      communityTimeZone: "UTC",
      tracing: noopTracing(),
      serviceToken: "bot-token",
    });
    identity.close();
    expect(abort).toHaveBeenCalledOnce();
    abort.mockRestore();
  });
});

// Канал доставки хаба (PER-598): право place_bids получателя перед чтением
// названия лота. Отказ Identity — исключение: повтор решает рендер.
describe("place bids reader", () => {
  const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

  it("asks Identity for the right to bid of the recipient", async () => {
    const rpc = vi.fn().mockResolvedValue({ granted: true });
    const reader = createPlaceBidsReader({ checkAccessRight: rpc });
    await expect(
      reader.holdsPlaceBids(identityId, { requestId: "req-1" }),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      { identityId, right: AccessRight.PLACE_BIDS },
      expect.objectContaining({ headers: { [requestIdHeader]: "req-1" } }),
    );
  });

  it("lets a refusal of Identity through", async () => {
    const down = new ConnectError("down", Code.Unavailable);
    const reader = createPlaceBidsReader({
      checkAccessRight: () => Promise.reject(down),
    });
    await expect(reader.holdsPlaceBids(identityId)).rejects.toBe(down);
  });
});

describe("telegram recipient resolver", () => {
  const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

  function failing(cause: unknown) {
    return createTelegramRecipientResolver({
      resolveTelegramUserId: () => Promise.reject(cause),
    });
  }

  it("returns the Telegram id of a known profile", async () => {
    const rpc = vi.fn().mockResolvedValue({ telegramUserId: 42n });
    const recipients = createTelegramRecipientResolver({
      resolveTelegramUserId: rpc,
    });
    await expect(
      recipients.resolveTelegramUserId(identityId, { requestId: "req-1" }),
    ).resolves.toEqual({ kind: "resolved", telegramUserId: 42n });
    expect(rpc).toHaveBeenCalledWith(
      { identityId },
      expect.objectContaining({ headers: { [requestIdHeader]: "req-1" } }),
    );
  });

  it("tells an unknown profile from a blocked one", async () => {
    await expect(
      failing(new ConnectError("unknown", Code.NotFound)).resolveTelegramUserId(
        identityId,
      ),
    ).resolves.toEqual({ kind: "not-found" });
    await expect(
      failing(
        new ConnectError("blocked", Code.FailedPrecondition),
      ).resolveTelegramUserId(identityId),
    ).resolves.toEqual({ kind: "blocked" });
  });

  it("keeps unavailability apart from a contract violation", async () => {
    await expect(
      failing(new ConnectError("down", Code.Unavailable)).resolveTelegramUserId(
        identityId,
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      failing(
        new ConnectError("bad id", Code.InvalidArgument),
      ).resolveTelegramUserId(identityId),
    ).resolves.toMatchObject({ kind: "rejected", code: "InvalidArgument" });
  });
});

describe("organizer resolver", () => {
  const organizerId = "0192f0a0-0000-7000-8000-00000000a001";
  const viewer = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };

  function failing(cause: unknown) {
    return createOrganizerResolver({
      resolveOrganizerUsername: () => Promise.reject(cause),
    });
  }

  it("sends the viewer as the actor and returns the username", async () => {
    const rpc = vi.fn().mockResolvedValue({ telegramUsername: "organizer" });
    const organizers = createOrganizerResolver({
      resolveOrganizerUsername: rpc,
    });
    await expect(
      organizers.resolveOrganizerUsername(viewer, organizerId, {
        requestId: "req-1",
      }),
    ).resolves.toEqual({ kind: "resolved", telegramUsername: "organizer" });
    expect(rpc).toHaveBeenCalledWith(
      {
        actor: {
          identityId: viewer.identityId,
        },
        identityId: organizerId,
      },
      expect.objectContaining({ headers: { [requestIdHeader]: "req-1" } }),
    );
  });

  it("resolves an organizer without a username to an absent field", async () => {
    const organizers = createOrganizerResolver({
      resolveOrganizerUsername: vi.fn().mockResolvedValue({}),
    });
    await expect(
      organizers.resolveOrganizerUsername(viewer, organizerId),
    ).resolves.toEqual({ kind: "resolved" });
  });

  it("separates not-found, unavailability and a contract violation", async () => {
    await expect(
      failing(
        new ConnectError("not an organizer", Code.NotFound),
      ).resolveOrganizerUsername(viewer, organizerId),
    ).resolves.toEqual({ kind: "not-found" });
    await expect(
      failing(
        new ConnectError("down", Code.Unavailable),
      ).resolveOrganizerUsername(viewer, organizerId),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      failing(
        new ConnectError("outside the hub", Code.PermissionDenied),
      ).resolveOrganizerUsername(viewer, organizerId),
    ).resolves.toMatchObject({ kind: "rejected", code: "PermissionDenied" });
  });
});

describe("application administrator", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };
  const applicationId = "0192f0a0-0000-7000-8000-00000000a001";

  function refusedRow(
    overrides: Partial<{
      queue: ApplicationQueue;
      outcome: ApplicationOutcome;
      decidedAt: string;
    }> = {},
  ) {
    return create(RefusedApplicationSchema, {
      applicationId,
      identityId: "0192f0a0-0000-7000-8000-00000000b001",
      telegramUserId: 42n,
      telegramUsername: "refused",
      queue: overrides.queue ?? ApplicationQueue.AUCTION,
      decision: {
        outcome: overrides.outcome ?? ApplicationOutcome.BLOCKED,
        decidedBy: { identityId: actor.identityId, telegramUserId: 7n },
        decidedAt: overrides.decidedAt ?? "2026-10-02T11:05:00.000Z",
      },
    });
  }

  function listing(...rows: ReturnType<typeof refusedRow>[]) {
    return createApplicationAdministrator(
      {
        listRefusedApplications: vi.fn().mockResolvedValue(
          create(ListRefusedApplicationsResponseSchema, {
            applications: rows,
          }),
        ),
        reconsiderApplication: vi.fn(),
      },
      { communityTimeZone: "Europe/Moscow" },
    );
  }

  it("maps a refusal and moves its moment into the community zone", async () => {
    const result = await listing(refusedRow()).refusedApplications(
      actor,
      "community",
    );

    expect(result).toEqual({
      kind: "ok",
      value: [
        {
          applicationId,
          identityId: "0192f0a0-0000-7000-8000-00000000b001",
          telegramUserId: 42n,
          telegramUsername: "refused",
          circle: "public",
          outcome: "blocked",
          decidedBy: { telegramUserId: 7n },
          decidedAt: { year: 2026, month: 10, day: 2, hours: 14, minutes: 5 },
        },
      ],
    });
  });

  it("reads a declined refusal of the hub circle", async () => {
    const result = await listing(
      refusedRow({
        queue: ApplicationQueue.COMMUNITY,
        outcome: ApplicationOutcome.DECLINED,
      }),
    ).refusedApplications(actor, "community");

    expect(result).toMatchObject({
      kind: "ok",
      value: [{ circle: "member", outcome: "declined" }],
    });
  });

  it.each([
    [
      "an outcome that is not a refusal",
      { outcome: ApplicationOutcome.ADMITTED },
    ],
    ["a queue the surfaces never ask", { queue: ApplicationQueue.UNSPECIFIED }],
    ["a moment that is not RFC 3339", { decidedAt: "yesterday" }],
  ])("calls the whole list a contract violation on %s", async (_, row) => {
    await expect(
      listing(refusedRow(), refusedRow(row)).refusedApplications(
        actor,
        "community",
      ),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("names the queue whose refusals it lists", async () => {
    const listRefusedApplications = vi
      .fn()
      .mockResolvedValue(create(ListRefusedApplicationsResponseSchema, {}));
    const administrator = createApplicationAdministrator(
      { listRefusedApplications, reconsiderApplication: vi.fn() },
      { communityTimeZone: "UTC" },
    );

    await administrator.refusedApplications(actor, "auction");

    expect(listRefusedApplications.mock.calls[0]?.[0]).toMatchObject({
      queue: ApplicationQueue.AUCTION,
    });
  });

  it("sends the actor and the application on reconsider", async () => {
    const reconsiderApplication = vi.fn().mockResolvedValue({ changed: false });
    const administrator = createApplicationAdministrator(
      {
        listRefusedApplications: vi.fn(),
        reconsiderApplication,
      },
      { communityTimeZone: "UTC" },
    );

    await expect(
      administrator.reconsiderApplication(actor, applicationId),
    ).resolves.toEqual({ kind: "ok", value: false });
    expect(reconsiderApplication).toHaveBeenCalledWith(
      {
        actor: {
          identityId: actor.identityId,
        },
        applicationId,
      },
      expect.anything(),
    );
  });

  it.each([
    [Code.FailedPrecondition, "not-refused"],
    [Code.PermissionDenied, "forbidden"],
    [Code.NotFound, "invalid"],
    [Code.Unavailable, "unavailable"],
  ])("maps reconsider failure %s to %s", async (code, kind) => {
    const administrator = createApplicationAdministrator(
      {
        listRefusedApplications: vi.fn(),
        reconsiderApplication: () =>
          Promise.reject(new ConnectError("refused", code)),
      },
      { communityTimeZone: "UTC" },
    );

    await expect(
      administrator.reconsiderApplication(actor, applicationId),
    ).resolves.toMatchObject({ kind });
  });
});

describe("community administrator", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };
  const memberId = "0192f0a0-0000-7000-8000-00000000d001";

  function community(
    overrides: Partial<Parameters<typeof createCommunityAdministrator>[0]> = {},
  ) {
    return createCommunityAdministrator({
      listCommunityMembers: vi.fn(),
      getCommunityMember: vi.fn(),
      blockCommunityMember: vi.fn(),
      listAllowedUsernames: vi.fn().mockResolvedValue({ usernames: [] }),
      addAllowedUsername: vi.fn(),
      removeAllowedUsername: vi.fn(),
      ...overrides,
    });
  }

  it("sends the filter and maps the circle and the moderation record", async () => {
    const listCommunityMembers = vi.fn().mockResolvedValue({
      members: [
        {
          identityId: memberId,
          telegramUsername: "moder",
          telegramUserId: 42n,
          admitted: true,
          circle: Circle.MEMBER,
          grantedRights: [AccessRight.ADMIT_BIDDERS],
        },
        {
          identityId: "guest",
          telegramUserId: 43n,
          admitted: false,
          circle: Circle.GUEST,
          grantedRights: [AccessRight.PLACE_BIDS],
        },
        {
          identityId: "newcomer",
          telegramUserId: 0n,
          admitted: false,
          circle: Circle.UNSPECIFIED,
          grantedRights: [],
        },
        // Старый Identity круга не присылает, участника называет admitted.
        {
          identityId: "older",
          telegramUserId: 44n,
          admitted: true,
          circle: Circle.UNSPECIFIED,
          grantedRights: [],
        },
      ],
    });

    await expect(
      community({ listCommunityMembers }).community(actor, "moderators"),
    ).resolves.toEqual({
      kind: "ok",
      value: {
        members: [
          {
            identityId: memberId,
            telegramUsername: "moder",
            telegramUserId: 42n,
            circle: "member",
            auctionModeration: true,
          },
          {
            identityId: "guest",
            telegramUserId: 43n,
            circle: "guest",
            auctionModeration: false,
          },
          { identityId: "newcomer", circle: "none", auctionModeration: false },
          {
            identityId: "older",
            telegramUserId: 44n,
            circle: "member",
            auctionModeration: false,
          },
        ],
        allowedUsernames: [],
      },
    });
    expect(listCommunityMembers).toHaveBeenCalledWith(
      {
        actor: { identityId: actor.identityId },
        grantedRight: AccessRight.ADMIT_BIDDERS,
      },
      expect.anything(),
    );
  });

  it("reads one member", async () => {
    const getCommunityMember = vi.fn().mockResolvedValue(
      create(GetCommunityMemberResponseSchema, {
        outcome: {
          case: "found",
          value: {
            identityId: memberId,
            telegramUserId: 42n,
            admitted: true,
            circle: Circle.MEMBER,
            grantedRights: [],
          },
        },
      }),
    );

    await expect(
      community({ getCommunityMember }).communityMember(actor, memberId),
    ).resolves.toEqual({
      kind: "ok",
      value: {
        identityId: memberId,
        telegramUserId: 42n,
        circle: "member",
        auctionModeration: false,
      },
    });
    expect(getCommunityMember).toHaveBeenCalledWith(
      { actor: { identityId: actor.identityId }, identityId: memberId },
      expect.anything(),
    );
  });

  it.each([
    ["notMembersManager", "forbidden"],
    ["identityUnknown", "identity-unknown"],
    ["identityBlocked", "blocked"],
    ["identityHoldsPreset", "holds-preset"],
  ] as const)("maps refusal %s to %s", async (reason, kind) => {
    const getCommunityMember = vi.fn().mockResolvedValue(
      create(GetCommunityMemberResponseSchema, {
        outcome: {
          case: "refused",
          value: { reason: { case: reason, value: {} } },
        },
      }),
    );

    await expect(
      community({ getCommunityMember }).communityMember(actor, memberId),
    ).resolves.toEqual({ kind });
  });

  it("answers unavailable to an outcome it does not know", async () => {
    const getCommunityMember = vi
      .fn()
      .mockResolvedValue(create(GetCommunityMemberResponseSchema, {}));

    await expect(
      community({ getCommunityMember }).communityMember(actor, memberId),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });
});

describe("auction moderation administrator", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };
  const memberId = "0192f0a0-0000-7000-8000-00000000b001";

  function moderation(
    overrides: Partial<
      Parameters<typeof createAuctionModerationAdministrator>[0]
    > = {},
  ) {
    return createAuctionModerationAdministrator({
      grantRight: vi.fn(),
      revokeRight: vi.fn(),
      ...overrides,
    });
  }

  it("sends the actor and the member on grant and revoke", async () => {
    const grantRight = vi.fn().mockResolvedValue({ changed: true });
    const revokeRight = vi.fn().mockResolvedValue({ changed: false });
    const administrator = moderation({ grantRight, revokeRight });

    await expect(
      administrator.grantAuctionModeration(actor, memberId),
    ).resolves.toEqual({ kind: "ok", value: true });
    await expect(
      administrator.revokeAuctionModeration(actor, memberId),
    ).resolves.toEqual({ kind: "ok", value: false });
    const request = {
      actor: { identityId: actor.identityId },
      identityId: memberId,
      right: AccessRight.ADMIT_BIDDERS,
    };
    expect(grantRight).toHaveBeenCalledWith(request, expect.anything());
    expect(revokeRight).toHaveBeenCalledWith(request, expect.anything());
  });

  it.each([
    [Code.FailedPrecondition, "not-member"],
    [Code.PermissionDenied, "forbidden"],
    [Code.Unavailable, "unavailable"],
  ])("maps grant failure %s to %s", async (code, kind) => {
    const administrator = moderation({
      grantRight: () => Promise.reject(new ConnectError("refused", code)),
    });

    await expect(
      administrator.grantAuctionModeration(actor, memberId),
    ).resolves.toMatchObject({ kind });
  });
});

describe("administrator manager", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };
  const memberId = "0192f0a0-0000-7000-8000-00000000c001";

  function manager(
    overrides: Partial<Parameters<typeof createAdministratorManager>[0]> = {},
  ) {
    return createAdministratorManager({
      listAdministrators: vi.fn(),
      appointAdministrator: vi.fn(),
      dismissAdministrator: vi.fn(),
      ...overrides,
    });
  }

  it("maps the holders with both preset marks", async () => {
    const administrators = manager({
      listAdministrators: vi.fn().mockResolvedValue(
        create(ListAdministratorsResponseSchema, {
          outcome: {
            case: "listed",
            value: {
              administrators: [
                {
                  identityId: actor.identityId,
                  telegramUsername: "keeper",
                  telegramUserId: 7n,
                  maintainer: true,
                  admin: false,
                },
                {
                  identityId: memberId,
                  telegramUserId: 42n,
                  maintainer: false,
                  admin: true,
                },
              ],
            },
          },
        }),
      ),
    });

    await expect(administrators.administrators(actor)).resolves.toEqual({
      kind: "ok",
      value: [
        {
          identityId: actor.identityId,
          telegramUsername: "keeper",
          telegramUserId: 7n,
          maintainer: true,
          admin: false,
        },
        {
          identityId: memberId,
          telegramUserId: 42n,
          maintainer: false,
          admin: true,
        },
      ],
    });
  });

  it("reads a refused list as forbidden", async () => {
    const administrators = manager({
      listAdministrators: vi.fn().mockResolvedValue(
        create(ListAdministratorsResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "notAdminGrantor", value: {} } },
          },
        }),
      ),
    });

    await expect(administrators.administrators(actor)).resolves.toEqual({
      kind: "forbidden",
    });
  });

  it("sends the actor and the username and reads the appointment", async () => {
    const appointAdministrator = vi.fn().mockResolvedValue(
      create(AppointAdministratorResponseSchema, {
        outcome: {
          case: "appointed",
          value: { identityId: memberId, changed: true },
        },
      }),
    );
    const administrators = manager({ appointAdministrator });

    await expect(
      administrators.appointAdministrator(actor, "@alice"),
    ).resolves.toEqual({
      kind: "ok",
      value: { identityId: memberId, changed: true },
    });
    expect(appointAdministrator).toHaveBeenCalledWith(
      { actor: { identityId: actor.identityId }, telegramUsername: "@alice" },
      expect.anything(),
    );
  });

  it.each([
    ["notAdminGrantor", "forbidden"],
    ["usernameUnknown", "username-unknown"],
    ["identityNotMember", "not-member"],
    ["identityBlocked", "blocked"],
    ["usernameUnresolved", "username-unresolved"],
  ] as const)("maps the appointment refusal %s to %s", async (reason, kind) => {
    const administrators = manager({
      appointAdministrator: vi.fn().mockResolvedValue(
        create(AppointAdministratorResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: reason, value: {} } },
          },
        }),
      ),
    });

    await expect(
      administrators.appointAdministrator(actor, "alice"),
    ).resolves.toEqual({ kind });
  });

  it("reads an empty outcome as an answer it does not know", async () => {
    const administrators = manager({
      appointAdministrator: vi
        .fn()
        .mockResolvedValue(create(AppointAdministratorResponseSchema, {})),
      dismissAdministrator: vi
        .fn()
        .mockResolvedValue(create(DismissAdministratorResponseSchema, {})),
    });

    await expect(
      administrators.appointAdministrator(actor, "alice"),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      administrators.dismissAdministrator(actor, memberId),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it.each([
    [Code.InvalidArgument, "invalid"],
    [Code.Unavailable, "unavailable"],
  ])("maps the appointment status %s to %s", async (code, kind) => {
    const administrators = manager({
      appointAdministrator: () =>
        Promise.reject(new ConnectError("refused", code)),
    });

    await expect(
      administrators.appointAdministrator(actor, "alice"),
    ).resolves.toMatchObject({ kind });
  });

  it("reads the dismissal and its refusals", async () => {
    const dismissAdministrator = vi
      .fn()
      .mockResolvedValueOnce(
        create(DismissAdministratorResponseSchema, {
          outcome: { case: "dismissed", value: { changed: false } },
        }),
      )
      .mockResolvedValueOnce(
        create(DismissAdministratorResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "identityUnknown", value: {} } },
          },
        }),
      )
      .mockResolvedValueOnce(
        create(DismissAdministratorResponseSchema, {
          outcome: {
            case: "refused",
            value: { reason: { case: "notAdminGrantor", value: {} } },
          },
        }),
      );
    const administrators = manager({ dismissAdministrator });

    await expect(
      administrators.dismissAdministrator(actor, memberId),
    ).resolves.toEqual({ kind: "ok", value: false });
    await expect(
      administrators.dismissAdministrator(actor, memberId),
    ).resolves.toEqual({ kind: "identity-unknown" });
    await expect(
      administrators.dismissAdministrator(actor, memberId),
    ).resolves.toEqual({ kind: "forbidden" });
    expect(dismissAdministrator).toHaveBeenCalledWith(
      { actor: { identityId: actor.identityId }, identityId: memberId },
      expect.anything(),
    );
  });
});

describe("application moderator", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  };
  const applicationId = "0192f0a0-0000-7000-8000-00000000a001";
  const createdAt = "2026-10-02T11:05:00.123Z";

  function reading(card?: Parameters<typeof cardRow>[0]) {
    const readApplicationQueue = vi.fn().mockResolvedValue(
      create(ReadApplicationQueueResponseSchema, {
        ...(card === undefined
          ? {}
          : { application: cardRow(card), position: 3 }),
        total: 17,
      }),
    );
    return {
      readApplicationQueue,
      moderator: createApplicationModerator({
        readApplicationQueue,
        admitApplication: vi.fn(),
        declineApplication: vi.fn(),
      }),
    };
  }

  function cardRow(
    overrides: Partial<{
      queue: ApplicationQueue;
      createdAt: string;
      source: { channelLabel?: string } | undefined;
    }> = {},
  ) {
    return create(ApplicationCardSchema, {
      applicationId,
      identityId: "0192f0a0-0000-7000-8000-00000000b001",
      telegramUserId: 42n,
      firstName: "Иван",
      queue: overrides.queue ?? ApplicationQueue.AUCTION,
      ...("source" in overrides
        ? overrides.source === undefined
          ? {}
          : { source: overrides.source }
        : { source: { channelLabel: "Солегуфики" } }),
      createdAt: overrides.createdAt ?? createdAt,
    });
  }

  it("maps a card and sends the cursor as an RFC 3339 moment", async () => {
    const { moderator, readApplicationQueue } = reading({});

    const result = await moderator.readApplicationQueue(actor, "auction", {
      createdAtMs: Date.parse(createdAt),
      applicationId,
    });

    expect(result).toEqual({
      kind: "ok",
      value: {
        card: {
          application: {
            applicationId,
            identityId: "0192f0a0-0000-7000-8000-00000000b001",
            telegramUserId: 42n,
            firstName: "Иван",
            circle: "public",
            source: { kind: "channel", label: "Солегуфики" },
            createdAtMs: Date.parse(createdAt),
          },
          position: 3,
        },
        total: 17,
      },
    });
    expect(readApplicationQueue).toHaveBeenCalledWith(
      {
        actor: {
          identityId: actor.identityId,
        },
        queue: ApplicationQueue.AUCTION,
        after: { createdAt, applicationId },
      },
      expect.anything(),
    );
  });

  it("reads from the start without a cursor", async () => {
    const { moderator, readApplicationQueue } = reading();

    await expect(
      moderator.readApplicationQueue(actor, "community", undefined),
    ).resolves.toEqual({ kind: "ok", value: { total: 17 } });
    expect(readApplicationQueue.mock.calls[0]?.[0]).not.toHaveProperty("after");
  });

  it.each([
    ["no source code", undefined, { kind: "none" }],
    ["a code the registry did not know", {}, { kind: "unknown" }],
  ])("tells %s apart", async (_, source, expected) => {
    const { moderator } = reading({ source });

    await expect(
      moderator.readApplicationQueue(actor, "community", undefined),
    ).resolves.toMatchObject({
      value: { card: { application: { source: expected } } },
    });
  });

  it.each([
    ["a queue the surfaces never ask", { queue: ApplicationQueue.UNSPECIFIED }],
    ["a moment that is not RFC 3339", { createdAt: "yesterday" }],
  ])("calls a card with %s a contract violation", async (_, card) => {
    await expect(
      reading(card).moderator.readApplicationQueue(
        actor,
        "community",
        undefined,
      ),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("tells a decision made now from one made before by another administrator", async () => {
    const decision = {
      outcome: ApplicationOutcome.ADMITTED,
      decidedBy: {
        identityId: actor.identityId,
        telegramUserId: 7n,
        telegramUsername: "admin",
      },
      decidedAt: createdAt,
    };
    const admitApplication = vi
      .fn()
      .mockResolvedValueOnce(
        create(DecideApplicationResponseSchema, {
          result: { case: "decided", value: decision },
        }),
      )
      .mockResolvedValueOnce(
        create(DecideApplicationResponseSchema, {
          result: { case: "alreadyDecided", value: decision },
        }),
      );
    const moderator = createApplicationModerator({
      readApplicationQueue: vi.fn(),
      admitApplication,
      declineApplication: vi.fn(),
    });

    await expect(
      moderator.admitApplication(actor, applicationId),
    ).resolves.toEqual({
      kind: "ok",
      value: {
        already: false,
        outcome: "admitted",
        decidedBy: { telegramUserId: 7n, telegramUsername: "admin" },
      },
    });
    await expect(
      moderator.admitApplication(actor, applicationId),
    ).resolves.toMatchObject({ kind: "ok", value: { already: true } });
    expect(admitApplication).toHaveBeenCalledWith(
      {
        actor: {
          identityId: actor.identityId,
        },
        applicationId,
      },
      expect.anything(),
    );
  });

  it("names the block outcome of a decline", async () => {
    const moderator = createApplicationModerator({
      readApplicationQueue: vi.fn(),
      admitApplication: vi.fn(),
      declineApplication: vi.fn().mockResolvedValue(
        create(DecideApplicationResponseSchema, {
          result: {
            case: "decided",
            value: {
              outcome: ApplicationOutcome.BLOCKED,
              decidedAt: createdAt,
            },
          },
        }),
      ),
    });

    await expect(
      moderator.declineApplication(actor, applicationId),
    ).resolves.toEqual({
      kind: "ok",
      value: { already: false, outcome: "blocked" },
    });
  });

  it("calls an empty decision a contract violation", async () => {
    const moderator = createApplicationModerator({
      readApplicationQueue: vi.fn(),
      admitApplication: vi
        .fn()
        .mockResolvedValue(create(DecideApplicationResponseSchema, {})),
      declineApplication: vi.fn(),
    });

    await expect(
      moderator.admitApplication(actor, applicationId),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it.each([
    [Code.PermissionDenied, "forbidden"],
    [Code.NotFound, "invalid"],
    [Code.Unavailable, "unavailable"],
  ])("maps a decision failure %s to %s", async (code, kind) => {
    const moderator = createApplicationModerator({
      readApplicationQueue: vi.fn(),
      admitApplication: vi.fn(),
      declineApplication: () =>
        Promise.reject(new ConnectError("refused", code)),
    });

    await expect(
      moderator.declineApplication(actor, applicationId),
    ).resolves.toMatchObject({ kind });
  });
});

describe("access requester", () => {
  const answer = (outcome: AccessRequestOutcome) =>
    create(RequestAccessResponseSchema, {
      identityId: "id-1",
      rights: [AccessRight.ACCESS_HUB, AccessRight.PLACE_BIDS],
      outcome,
    });

  it("applies to the queue with the channel code and the first name", async () => {
    const requestAccess = vi.fn(async () =>
      answer(AccessRequestOutcome.GRANTED_BY_ALLOWLIST),
    );
    const identity = createAccessRequester({ requestAccess }, 75);
    await expect(
      identity.requestAccess(
        {
          telegramUserId: 42n,
          telegramUsername: "alice",
          queue: "community",
          sourceCode: "tg_ads",
          firstName: "Сова",
        },
        { requestId: "req-1", useCase: "find_meetup" },
      ),
    ).resolves.toEqual({
      kind: "answered",
      identityId: "id-1",
      rights: ["access-hub", "place-bids"],
      outcome: "granted-by-allowlist",
    });
    expect(requestAccess).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        telegramUsername: "alice",
        queue: ApplicationQueue.COMMUNITY,
        sourceCode: "tg_ads",
        firstName: "Сова",
      },
      {
        timeoutMs: 75,
        headers: {
          [requestIdHeader]: "req-1",
          [useCaseHeader]: "find_meetup",
        },
      },
    );
  });

  // Присутствие кода значимо: пустой код едет пустой строкой, отсутствующий
  // поля в запросе не оставляет.
  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])("sends the channel code %j as received", async (sourceCode, expected) => {
    const requestAccess = vi.fn(async () =>
      answer(AccessRequestOutcome.PENDING),
    );
    await createAccessRequester({ requestAccess }).requestAccess({
      telegramUserId: 42n,
      queue: "auction",
      ...(sourceCode === undefined ? {} : { sourceCode }),
      firstName: "Сова",
    });
    expect(requestAccess).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        queue: ApplicationQueue.AUCTION,
        firstName: "Сова",
        ...expected,
      },
      expect.anything(),
    );
  });

  it.each([
    [AccessRequestOutcome.ALREADY_HELD, "already-held"],
    [AccessRequestOutcome.GRANTED_BY_ALLOWLIST, "granted-by-allowlist"],
    [AccessRequestOutcome.PENDING, "pending"],
    [AccessRequestOutcome.DECLINED, "declined"],
    [AccessRequestOutcome.BLOCKED, "blocked"],
    [AccessRequestOutcome.UNSPECIFIED, "unspecified"],
    // Число, которого словарь ещё не знает, — отказ, а не допуск.
    [99 as AccessRequestOutcome, "unspecified"],
  ])("reads the outcome %s as %s", async (wire, outcome) => {
    const identity = createAccessRequester({
      requestAccess: async () => answer(wire),
    });
    await expect(
      identity.requestAccess({
        telegramUserId: 42n,
        queue: "community",
        firstName: "Сова",
      }),
    ).resolves.toMatchObject({ kind: "answered", outcome });
  });

  it("tells an unavailable Identity from a rejected request", async () => {
    const failing = (cause: unknown) =>
      createAccessRequester({
        requestAccess: () => Promise.reject(cause),
      }).requestAccess({
        telegramUserId: 42n,
        queue: "community",
        firstName: "Сова",
      });
    await expect(
      failing(new ConnectError("connect", Code.Unavailable)),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      failing(new ConnectError("queue", Code.InvalidArgument)),
    ).resolves.toMatchObject({ kind: "rejected", code: "InvalidArgument" });
  });

  it("does not call identity once the action budget is spent", async () => {
    const requestAccess = vi.fn();
    await expect(
      createAccessRequester({ requestAccess }).requestAccess(
        { telegramUserId: 42n, queue: "community", firstName: "Сова" },
        { deadlineAt: Date.now() - 1 },
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(requestAccess).not.toHaveBeenCalled();
  });
});
