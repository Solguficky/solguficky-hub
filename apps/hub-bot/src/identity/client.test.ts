import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationCardSchema,
  ApplicationOutcome,
  DecideApplicationResponseSchema,
  ListRefusedApplicationsResponseSchema,
  ReadApplicationQueueResponseSchema,
  RefusedApplicationSchema,
  RequestRoleResponseSchema,
  ResolveIdentityResponseSchema,
  RoleRequestOutcome,
} from "../../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import { noopTracing } from "../tracing.js";
import {
  createApplicationAdministrator,
  createApplicationModerator,
  createIdentityClient,
  createIdentityResolver,
  createOrganizerResolver,
  createRoleRequester,
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
            globalRoles: [GlobalRole.ADMIN],
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
      globalRoles: ["admin"],
      blocked: false,
    });
    expect(seenTimeout).toBe(75);
  });

  it("maps every known global role to its canonical name", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: async () =>
        create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
          globalRoles: [
            GlobalRole.MAINTAINER,
            GlobalRole.ADMIN,
            GlobalRole.MEMBER,
            GlobalRole.GUEST,
          ],
        }),
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      globalRoles: ["maintainer", "admin", "member", "public"],
      blocked: false,
    });
  });

  it("reads the blocked mark separately from the role set", async () => {
    const identity = createIdentityResolver({
      resolveIdentity: async () =>
        create(ResolveIdentityResponseSchema, {
          identityId: "id-1",
          globalRoles: [GlobalRole.ADMIN],
          blocked: true,
        }),
    });

    await expect(identity.resolve({ telegramUserId: 1n })).resolves.toEqual({
      kind: "resolved",
      identityId: "id-1",
      globalRoles: ["admin"],
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
      globalRoles: [],
      blocked: true,
    });
  });

  // Поле 2 (global_roles) со значением 99 и поле 3 (blocked) = true: более новая
  // Identity может прислать роль, которой этот клиент ещё не знает. Разбор не
  // падает, роль игнорируется, отметка читается отдельно.
  it("parses an unknown role value off the wire and ignores it", async () => {
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
      globalRoles: [],
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
    globalRoles: ["member"],
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
          globalRoles: [GlobalRole.MEMBER],
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
    globalRoles: ["admin"],
  };
  const applicationId = "0192f0a0-0000-7000-8000-00000000a001";

  function refusedRow(
    overrides: Partial<{
      requestedRole: GlobalRole;
      outcome: ApplicationOutcome;
      decidedAt: string;
    }> = {},
  ) {
    return create(RefusedApplicationSchema, {
      applicationId,
      identityId: "0192f0a0-0000-7000-8000-00000000b001",
      telegramUserId: 42n,
      telegramUsername: "refused",
      requestedRole: overrides.requestedRole ?? GlobalRole.GUEST,
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
    const result = await listing(refusedRow()).refusedApplications(actor);

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
        requestedRole: GlobalRole.MEMBER,
        outcome: ApplicationOutcome.DECLINED,
      }),
    ).refusedApplications(actor);

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
    ["a circle the surfaces never ask", { requestedRole: GlobalRole.ADMIN }],
    ["a moment that is not RFC 3339", { decidedAt: "yesterday" }],
  ])("calls the whole list a contract violation on %s", async (_, row) => {
    await expect(
      listing(refusedRow(), refusedRow(row)).refusedApplications(actor),
    ).resolves.toEqual({ kind: "invalid" });
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
          globalRoles: [GlobalRole.ADMIN],
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

describe("application moderator", () => {
  const actor = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    globalRoles: ["admin"],
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
      requestedRole: GlobalRole;
      createdAt: string;
      source: { channelLabel?: string } | undefined;
    }> = {},
  ) {
    return create(ApplicationCardSchema, {
      applicationId,
      identityId: "0192f0a0-0000-7000-8000-00000000b001",
      telegramUserId: 42n,
      firstName: "Иван",
      requestedRole: overrides.requestedRole ?? GlobalRole.GUEST,
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

    const result = await moderator.readApplicationQueue(actor, {
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
          globalRoles: [GlobalRole.ADMIN],
        },
        after: { createdAt, applicationId },
      },
      expect.anything(),
    );
  });

  it("reads from the start without a cursor", async () => {
    const { moderator, readApplicationQueue } = reading();

    await expect(
      moderator.readApplicationQueue(actor, undefined),
    ).resolves.toEqual({ kind: "ok", value: { total: 17 } });
    expect(readApplicationQueue.mock.calls[0]?.[0]).not.toHaveProperty("after");
  });

  it.each([
    ["no source code", undefined, { kind: "none" }],
    ["a code the registry did not know", {}, { kind: "unknown" }],
  ])("tells %s apart", async (_, source, expected) => {
    const { moderator } = reading({ source });

    await expect(
      moderator.readApplicationQueue(actor, undefined),
    ).resolves.toMatchObject({
      value: { card: { application: { source: expected } } },
    });
  });

  it.each([
    ["a circle the surfaces never ask", { requestedRole: GlobalRole.ADMIN }],
    ["a moment that is not RFC 3339", { createdAt: "yesterday" }],
  ])("calls a card with %s a contract violation", async (_, card) => {
    await expect(
      reading(card).moderator.readApplicationQueue(actor, undefined),
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
          globalRoles: [GlobalRole.ADMIN],
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

describe("role requester", () => {
  const answer = (outcome: RoleRequestOutcome) =>
    create(RequestRoleResponseSchema, {
      identityId: "id-1",
      globalRoles: [GlobalRole.MEMBER, GlobalRole.GUEST],
      outcome,
    });

  it("requests the circle with the channel code and the first name", async () => {
    const requestRole = vi.fn(async () =>
      answer(RoleRequestOutcome.GRANTED_BY_ALLOWLIST),
    );
    const identity = createRoleRequester({ requestRole }, 75);
    await expect(
      identity.requestRole(
        {
          telegramUserId: 42n,
          telegramUsername: "alice",
          requestedRole: "member",
          sourceCode: "tg_ads",
          firstName: "Сова",
        },
        { requestId: "req-1", useCase: "find_meetup" },
      ),
    ).resolves.toEqual({
      kind: "answered",
      identityId: "id-1",
      globalRoles: ["member", "public"],
      outcome: "granted-by-allowlist",
    });
    expect(requestRole).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        telegramUsername: "alice",
        requestedRole: GlobalRole.MEMBER,
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
    const requestRole = vi.fn(async () => answer(RoleRequestOutcome.PENDING));
    await createRoleRequester({ requestRole }).requestRole({
      telegramUserId: 42n,
      requestedRole: "public",
      ...(sourceCode === undefined ? {} : { sourceCode }),
      firstName: "Сова",
    });
    expect(requestRole).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        requestedRole: GlobalRole.GUEST,
        firstName: "Сова",
        ...expected,
      },
      expect.anything(),
    );
  });

  it.each([
    [RoleRequestOutcome.ALREADY_HELD, "already-held"],
    [RoleRequestOutcome.GRANTED_BY_ALLOWLIST, "granted-by-allowlist"],
    [RoleRequestOutcome.PENDING, "pending"],
    [RoleRequestOutcome.DECLINED, "declined"],
    [RoleRequestOutcome.BLOCKED, "blocked"],
    [RoleRequestOutcome.UNSPECIFIED, "unspecified"],
    // Число, которого словарь ещё не знает, — отказ, а не допуск.
    [99 as RoleRequestOutcome, "unspecified"],
  ])("reads the outcome %s as %s", async (wire, outcome) => {
    const identity = createRoleRequester({
      requestRole: async () => answer(wire),
    });
    await expect(
      identity.requestRole({
        telegramUserId: 42n,
        requestedRole: "member",
        firstName: "Сова",
      }),
    ).resolves.toMatchObject({ kind: "answered", outcome });
  });

  it("tells an unavailable Identity from a rejected request", async () => {
    const failing = (cause: unknown) =>
      createRoleRequester({
        requestRole: () => Promise.reject(cause),
      }).requestRole({
        telegramUserId: 42n,
        requestedRole: "member",
        firstName: "Сова",
      });
    await expect(
      failing(new ConnectError("connect", Code.Unavailable)),
    ).resolves.toMatchObject({ kind: "unavailable" });
    await expect(
      failing(new ConnectError("requested_role", Code.InvalidArgument)),
    ).resolves.toMatchObject({ kind: "rejected", code: "InvalidArgument" });
  });

  it("does not call identity once the action budget is spent", async () => {
    const requestRole = vi.fn();
    await expect(
      createRoleRequester({ requestRole }).requestRole(
        { telegramUserId: 42n, requestedRole: "member", firstName: "Сова" },
        { deadlineAt: Date.now() - 1 },
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(requestRole).not.toHaveBeenCalled();
  });
});
